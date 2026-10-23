/**
 * 技术债处理器（ipc/engines-techdebt.ts）
 *
 * 技术债仪表盘消费（只读 inspect 域快照）与债务动作（计划还款 / 验证还款 / 忽略）。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { t } from '@zh/i18n';
import { buildTechDebtDashboard, mergeActionStatuses, computeTrendDelta } from '@zh/scoring';
import type { DebtIssueInput, ModuleHotnessInput } from '@zh/scoring';
import {
  saveDebtAction,
  updateDebtActionStatus,
  getDebtActionsByProject,
  saveDebtSnapshot,
  getLatestDebtSnapshot,
} from '@zh/db';
import {
  persistDiagnosticsFromEntries,
  normalizeTechDebtSource,
  readDomainSnapshot,
} from '../zh-diagnostics';
import { updateDashboardState } from './dashboard-state';
import { collectExposedFilesInWorker } from '../profile-host';
import { getDb } from '../ipc-context';
import type { TechDebtReportData } from '../../src/types/electron';
import type { TaskProgressReporter } from '../task-progress';

/**
 * 统计项目近 90 天模块热度：只读 `git log --since=90.days --name-only`，
 * 按文件路径去重计数提交出现次数。git 不可用 / 非 git 仓库 → 空数组。
 */
function collectModuleHotness(projectPath: string): Promise<ModuleHotnessInput[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', '--since=90.days', '--pretty=format:', '--name-only'],
      { cwd: projectPath, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn('[engine:runTechDebt] git log 失败，模块热度置空:', err.message);
          resolve([]);
          return;
        }
        const counts = new Map<string, number>();
        for (const raw of stdout.split('\n')) {
          const file = raw.trim();
          if (!file) continue;
          counts.set(file, (counts.get(file) ?? 0) + 1);
        }
        const hotness = Array.from(counts.entries(), ([module, commitCount]) => ({
          module,
          commitCount,
        })).sort((a, b) => b.commitCount - a.commitCount);
        resolve(hotness);
      },
    );
  });
}

/**
 * 技术债的输入来自 **inspect 域最近一次落盘快照**（只读，不发起检查）。
 *
 * 背景（T6）：`runTechDebt` / `planDebtRepayment` / `verifyDebtRepaid` 三处此前都直接
 * `runInspectTask()` —— 打开技术债页、计划还款、验证还款，各触发一次 11 工具完整巡检。
 * 这违反「触发权域内独占」：技术债只是**消费**巡检结论并叠加 git 热度算出 ROI，
 * 判定权不在它手里。
 *
 * 跨域消费的正确写法是「只读结果，不发起检查」：读 `.zhshield/diagnostics/domains/inspect.json`
 * （由 inspect 域自己落盘，按域分文件，不被其他域覆盖写清掉）。
 *
 * projectId 沿用 `InspectionReport.projectId` 的口径 —— 那是 `path.resolve(projectPath)`
 * 后的**绝对路径**（inspect/src/engine.ts 归一化），且 @zh/db 的债务快照/动作表都以它为键。
 * **不可**换成 hash 型 projectId，否则历史趋势与动作状态会静默失联。
 */
export type DebtInputResult =
  | { ok: true; projectId: string; issues: DebtIssueInput[]; generatedAt: string }
  | { ok: false; reason: 'no-snapshot' };

export async function loadDebtInputFromSnapshot(projectPath: string): Promise<DebtInputResult> {
  const snapshot = await readDomainSnapshot(projectPath, 'inspect');
  if (!snapshot) return { ok: false, reason: 'no-snapshot' };
  return {
    ok: true,
    projectId: path.resolve(projectPath),
    generatedAt: snapshot.generatedAt,
    issues: snapshot.issues.map((entry) => ({
      id: entry.fingerprint,
      severity: entry.severity,
      category: entry.category,
      file: entry.file,
    })),
  };
}

/**
 * 技术债仪表盘（engine:runTechDebt）：直连主进程，不注册 TaskManager 任务类型。
 * 读 inspect 域落盘快照（只读），叠加 git 模块热度 + 对外接口清单，
 * 由 @zh/scoring buildTechDebtDashboard 生成 ROI 排序报告。
 * 无快照时返回带 error 的空报告（显式提示先跑体检），不静默显示 0 债务。
 */
/** 组装技术债仪表盘快照：读 inspect 快照 + git 模块热度 + 对外接口清单 */
export async function buildTechDebtSnapshot(
  projectPath: string,
  input: Extract<DebtInputResult, { ok: true }>,
): Promise<ReturnType<typeof buildTechDebtDashboard>> {
  const moduleHotness = await collectModuleHotness(projectPath);
  const exposedFiles = await collectExposedFilesInWorker(projectPath);
  return buildTechDebtDashboard({
    projectId: input.projectId,
    issues: input.issues,
    moduleHotness,
    exposedFiles,
  });
}

/** 合并债务动作状态与趋势（best-effort：持久化不可用时降级为纯计算） */
export async function mergeDebtPersistence(
  snapshot: ReturnType<typeof buildTechDebtDashboard>,
): Promise<ReturnType<typeof buildTechDebtDashboard>> {
  try {
    const db = getDb();
    const projectId = snapshot.projectId;
    const persisted = getDebtActionsByProject(db, projectId);
    let finalSnapshot = {
      ...snapshot,
      actionList: mergeActionStatuses(
        snapshot.actionList,
        persisted.map((row) => ({ actionId: row.action_id, status: row.status })),
      ),
    };
    const previous = getLatestDebtSnapshot(db, projectId);
    finalSnapshot = {
      ...finalSnapshot,
      trend: {
        ...finalSnapshot.trend,
        delta: computeTrendDelta(snapshot.debtIndex, previous ? previous.debt_index : null),
      },
    };
    saveDebtSnapshot(db, { projectId, debtIndex: snapshot.debtIndex });
    return finalSnapshot;
  } catch (err) {
    console.warn(
      '[engine:runTechDebt] 债务状态持久化不可用，降级为纯计算:',
      err instanceof Error ? err.message : String(err),
    );
    return snapshot;
  }
}

/** 技术债报告落盘诊断（best-effort，失败仅记录日志） */
export async function persistTechDebtDiagnostics(
  projectPath: string,
  report: TechDebtReportData,
): Promise<void> {
  try {
    await persistDiagnosticsFromEntries(projectPath, normalizeTechDebtSource(report), ['techdebt']);
  } catch (e) {
    console.warn(
      '[engine:runTechDebt] 诊断落盘失败:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** P1b: 补写 dashboard-state techdebt 域（debtIndex + 动作数 + lastRunAt） */
export async function updateTechDebtDashboard(
  projectPath: string,
  report: TechDebtReportData,
): Promise<void> {
  await updateDashboardState(projectPath, {
    techdebt: {
      debtIndex: report.debtIndex,
      issueCount: report.actionList.length,
      lastRunAt: new Date().toISOString(),
    },
  });
}

export async function planDebtRepaymentHandler(
  projectPath: string,
  actionId: string,
  opts?: { sprint?: string; gate?: 'allow-with-record' },
): Promise<void> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    ) {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // 只读快照：这里的 action 本来就取自同一份快照（页面渲染用的就是它），
    // 读快照比重新全量巡检更一致，也避免「点还款又跑一次 11 工具」。
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:debt:planRepayment] 无 inspect 域快照，请先运行项目体检');
      return;
    }
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: input.projectId,
      issues: input.issues,
      moduleHotness,
      exposedFiles,
    });
    const action = snapshot.actionList.find((a) => a.actionId === actionId);
    if (!action) {
      console.warn(`[engine:debt:planRepayment] action 未找到: ${actionId}`);
      return;
    }
    const db = getDb();
    saveDebtAction(db, {
      projectId: snapshot.projectId,
      actionId,
      status: 'planned',
      module: action.module,
      category: action.category,
      issueIds: action.issueIds,
      interestScore: action.interestScore,
      principalEstimate: action.principalEstimate,
      roi: action.roi,
      sprint: opts?.sprint ?? undefined,
      gate: opts?.gate ?? undefined,
    });
  } catch (err) {
    console.warn(
      '[engine:debt:planRepayment] 计划偿还失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 验证还款：按 inspect 域最新落盘快照判定该 action 是否仍存在。
 *
 * 语义说明（T6）：本方法天然需要「新鲜」的巡检结果，但它无权发起巡检
 * （触发权属体检/inspect 域）。因此正确用法是：用户修完后先重跑项目体检
 * 让快照刷新，再回来点验证。快照缺失或未刷新时**保守返回 false**——
 * 宁可显示「未还清」，绝不在没有证据时宣称「已还清」。
 */
export async function verifyDebtRepaidHandler(
  projectPath: string,
  actionId: string,
): Promise<boolean> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    )
      return false;
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:debt:verifyRepaid] 无 inspect 域快照，保守判为未还清');
      return false;
    }
    const moduleHotness = await collectModuleHotness(projectPath);
    const exposedFiles = await collectExposedFilesInWorker(projectPath);
    const snapshot = buildTechDebtDashboard({
      projectId: input.projectId,
      issues: input.issues,
      moduleHotness,
      exposedFiles,
    });
    const stillPresent = snapshot.actionList.some((a) => a.actionId === actionId);
    if (stillPresent) return false;
    const db = getDb();
    updateDebtActionStatus(db, { projectId: snapshot.projectId, actionId, status: 'repaid' });
    return true;
  } catch (err) {
    console.warn(
      '[engine:debt:verifyRepaid] 验证失败:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

export async function dismissDebtActionHandler(projectPath: string, actionId: string): Promise<void> {
  try {
    if (
      !projectPath ||
      typeof projectPath !== 'string' ||
      !actionId ||
      typeof actionId !== 'string'
    )
      return;
    const db = getDb();
    // projectId 必须是 resolve 后的绝对路径：本文件其余技术债写点（mergeDebtPersistence /
    // planDebtRepayment / verifyDebtRepaid）都用 snapshot.projectId，而 updateDebtActionStatus
    // 是纯 UPDATE（非 upsert）。此处若传原始 projectPath，当二者不一致（尾斜杠、./.. 段）
    // 时 WHERE 命中 0 行，dismiss 会静默失效，而 UI 已乐观置为 dismissed。
    updateDebtActionStatus(db, {
      projectId: path.resolve(projectPath),
      actionId,
      status: 'dismissed',
    });
  } catch (err) {
    console.warn(
      '[engine:debt:dismiss] 忽略操作失败:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** 技术债仪表盘失败时的空报告（error 携带失败原因，不 throw） */
function emptyTechDebtReport(error: string): TechDebtReportData {
  return {
    projectId: '',
    generatedAt: new Date().toISOString(),
    debtIndex: 0,
    trend: { period: 'week', delta: 0 },
    byModule: [],
    byCategory: [],
    actionList: [],
    error,
  };
}

/**
 * 硬前置：无 inspect 快照时返回携带 `error` 的空报告而非抛错 ——
 * 任务中心据此以 done + 空报告结束，UI 展示「请先运行项目体检」。
 */
export async function runTechDebtHandler(
  projectPath: string,
  onProgress?: TaskProgressReporter,
): Promise<TechDebtReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    onProgress?.('techdebt', t('pipeline.techdebt.loadingSnapshot'), 0.1);
    const input = await loadDebtInputFromSnapshot(projectPath);
    if (!input.ok) {
      console.warn('[engine:runTechDebt] 无 inspect 域快照，提示先运行项目体检');
      return emptyTechDebtReport(t('electron.techDebtNoSnapshot'));
    }
    onProgress?.('techdebt', t('pipeline.techdebt.computing'), 0.35);
    const snapshot = await buildTechDebtSnapshot(projectPath, input);
    const finalSnapshot = await mergeDebtPersistence(snapshot);
    const report: TechDebtReportData = { ...finalSnapshot, error: null };
    await persistTechDebtDiagnostics(projectPath, report);
    await updateTechDebtDashboard(projectPath, report);
    return report;
  } catch (err) {
    console.error('[engine:runTechDebt] Error:', err);
    return emptyTechDebtReport(err instanceof Error ? err.message : String(err));
  }
}
