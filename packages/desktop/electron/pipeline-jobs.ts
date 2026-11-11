/**
 * 单引擎任务执行
 *
 * 独立的「重构 / 门禁 / 安全 / 垃圾清理 / 性能」任务，由子进程消息路由分发，
 * 每个任务创建对应引擎并在完成后发送结果消息。
 *
 * 注：巡检（inspect）与门禁（guard）的**规则集口径**统一后，本文件不再自建引擎，
 * 一律经 `createLoadedRunner` 装配（见 pipeline-runner-factory 的说明）。
 * 巡检单引擎通道（runInspectJob）已移除——渲染层无调用方，巡检页走 SOP 流水线、
 * MCP 走 CLI，保留它只会制造第三份规则集。
 */
import { t } from '@zh/i18n';
import { serializePipelineReport } from './pipeline-protocol';
import { toSecurityScanReportData } from './ipc/report-format';
import { progress, send } from './pipeline-ipc';
import { createLoadedRunner } from './pipeline-runner-factory';
import { loadGuardConclusions } from './pipeline-sop';
import type { PerformanceReportIssue } from './pipeline-report';
import type { CheckOptions } from '@zh/guard';
import type { GarbageScanReport } from '@zh/garbage';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDomain } from '@zh/pipeline';
import type { DomainRunRecord } from '@zh/pipeline';
import {
  appendDomainHistory,
  buildRecordFromFingerprints,
  normalizeFingerprint,
} from './domain-history';
import { computeDomainSnapshotScore } from './domain-snapshot-score';

/** garbage 快照串行化写入队列：并发并发多轮扫描时避免 writeFile 交错覆盖（对齐 dashboard-state writeQueue 模式） */
let garbageSnapshotQueue: Promise<void> = Promise.resolve();

/**
 * 域记录 → worker 消息：有报告回结果，没报告（域不可用）回错误。
 *
 * 不伪造空报告：空报告 = 0 问题 = 满分，会把「没检测成」读成「干净」（C4/P1-B）。
 */
function sendDomainOutcome(id: string, record: DomainRunRecord): void {
  if (record.report !== undefined) {
    send({ type: 'result', id, report: serializePipelineReport(record.report) });
    return;
  }
  send({ type: 'error', id, error: record.reason ?? `域 ${record.domain} 未产出报告` });
}

/**
 * 安全完整报告落盘：由 worker 在扫描结束、上报完成**之前**写。
 *
 * 为什么不在渲染层写：完整报告此前只在「安全页仍挂载且拿到回传结果」时由
 * `useSavedDomainReport` 落盘。安全扫描约 3 分钟，期间切页/重挂载、或回传失败，
 * 结果就只活在内存里；项目体检流水线路径更是从不写完整报告。后果是重启后安全页
 * 永远退回上一次落盘的旧账（2026-11-11 实测：14:42 扫描完成，
 * `reports/security.json` 仍是 09:39 的旧结果，6 条修复前的降级被当成「本次结果」）。
 *
 * 写盘失败不阻断扫描上报 —— 回看是增强能力，不能拖垮主链路。
 */
async function persistSecurityReport(projectPath: string, report: unknown): Promise<void> {
  try {
    const dir = join(projectPath, '.zhshield', 'reports');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'security.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.warn(
      '[pipeline-worker] 安全报告落盘失败（扫描结果仍照常上报）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runRefactorJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'refactor', t('pipeline.refactor.collecting'), 0.05);
  progress(id, 'refactor', t('pipeline.refactor.analyzing'), 0.2);
  // 分析与棘轮基线过滤的唯一实现在 pipeline 的 refactor 执行器（含基线豁免）
  const record = await runDomain('refactor', { repoRoot: projectPath });
  if (record.status === 'unavailable') {
    console.error('[pipeline-worker] 重构分析异常:', record.reason);
    sendDomainOutcome(id, record);
    return;
  }
  const report = record.report as { totalSmells: number };
  const suppressedCount = Number(record.detail?.suppressedCount ?? 0);
  const note =
    suppressedCount > 0
      ? t('pipeline.refactor.baselineSuppressed', { count: suppressedCount })
      : '';
  progress(id, 'done', t('pipeline.refactor.done', { count: report.totalSmells }) + note, 1.0);
  sendDomainOutcome(id, record);
}

/**
 * 重构一键自动修复任务。
 *
 * 「扫描 → 生成补丁 → 备份目标文件 → 应用」全在子进程里跑（`analyzeDirectory` 是
 * 全量 AST 扫描，不能放主进程，否则 macOS 彩球）。备份到
 * `.zhshield/backups/refactor-autofix-<时间戳>/`，可整目录回滚。
 */
export async function runRefactorAutoFixJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'refactor', t('pipeline.refactor.autofixScanning'), 0.2);
  const { RefactorEngine } = await import('@zh/refactor');
  try {
    const result = await new RefactorEngine().applyAutoFixes(projectPath);
    progress(id, 'refactor', t('pipeline.refactor.autofixApplying'), 0.85);
    progress(id, 'done', t('pipeline.refactor.autofixDone', { count: result.fixed }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 自动修复异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 门禁任务 — 规则集与流水线门禁阶段**同源**（T13 口径统一）。
 *
 * 此前本函数自建 GuardEngine 并自行注册 6 个适配器，但**没有** `useSopEngine` 连线，
 * 于是 `GuardEngine.run()` 走 runTraditional 分支读 `guard/config/checks.json`
 * （4 项：ARCH-001 / LINT-001 / TEST-001 / SEC-001），而体检流水线的门禁阶段走
 * SOP 门禁规则 —— 同一个「门禁」两个规则集，页面点与流水线跑的条目数、结论都不一致。
 *
 * 现改为经 `createLoadedRunner` 装配：runner 内部已完成 `useSopEngine` 连线与
 * 适配器注册，`runGuard` 因此与流水线门禁阶段执行完全相同的 SOP 规则集。
 *
 * 已知缺口（不掩盖）：SOP 门禁域当前无「测试运行」规则，checks.json 时代的 TEST-001
 * 因此不再出现在门禁页。补该规则需要新增 ToolAdapter（ToolId 枚举 + tools.json），
 * 属独立立项，见交付说明遗留项。
 */
export async function runGuardJob(
  id: string,
  projectPath: string,
  options?: Record<string, unknown>,
): Promise<void> {
  progress(id, 'guard', t('pipeline.guard.jobScanning'), 0.1);
  const { runner, syncedRules } = await createLoadedRunner(projectPath);
  if (syncedRules > 0) {
    progress(id, 'guard', `同步规则已加载 ${syncedRules} 条`, 0.15);
  }
  try {
    // 《07》O8/C3：门禁纯判定 —— 只读各域已落盘结论，不执行任何扫描器。
    // 门禁页要的是 GuardReport（summary/results），故仍走 runGuard（内部即 SOP 门禁），
    // 与无头账本用的 runSopGuard 是同一套规则；只是输出契约不同。
    // 结论集从用户打开的项目（状态根）读，而不是 runner.repoRoot：
    // repoRoot 可能已因「容器目录下探」指向嵌套仓库，那里是另一份快照。
    const conclusions = await loadGuardConclusions(projectPath);
    const report = await runner.runGuard({
      mode: 'guard',
      target: projectPath,
      ...(options ?? {}),
      conclusions,
    } as Partial<CheckOptions>);
    progress(id, 'done', t('pipeline.guard.jobDone'), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 门禁扫描异常:', message);
    send({ type: 'error', id, error: message });
  } finally {
    await runner.destroy().catch(() => undefined);
  }
}

export async function runSecurityJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'security', t('pipeline.security.scanning'), 0.1);
  // P1-A：引擎事件接通 worker progress 通道。此前 emit 为 noop、事件全被丢弃，
  // 5 分钟安全扫描全程只有开头一条 10% → 用户毫无进度感、"一下跳 100"。
  // 编排器串行跑 4 个外部工具（trivy/grype/depcheck/semgrep）：
  // 每个工具开始/完成各上报一次，步进覆盖 10%→90%（步长 0.2 与默认 4 工具对齐）。
  // 引擎的装配与事件透传归 pipeline 的 security 执行器，这里只做文案映射。
  //
  // ⚠️ runner 必须经 createLoadedRunner 装配（2026-11-02 修复）：
  //   安全域的 SOP 规则通道需要规则集（runSopInspect({domains:['security']})），
  //   没有 runner 就只剩启发式通道 —— 那 7 条 semgrep 规则（SQL 注入 / XSS /
  //   命令注入 / CSRF / 路径穿越）一条都不会求值，用户看到的是「0 检出但状态正常」。
  //   实测：修复前 CLI 检出 1 条、桌面端 0 检出；修复后两者一致。
  const { runner } = await createLoadedRunner(projectPath);
  let toolsDone = 0;
  const record = await runDomain('security', {
    repoRoot: projectPath,
    runner,
    onEvent: (event) => {
      const tool = String(event.payload?.tool ?? '');
      if (event.kind === 'tool:scan-started') {
        progress(
          id,
          'security',
          t('pipeline.security.toolRunning', { tool }),
          Math.min(0.9, 0.1 + toolsDone * 0.2),
        );
        return;
      }
      if (event.kind === 'tool:executed') {
        toolsDone += 1;
        // 状态诚实分支：error/unavailable/skipped（如 grype 漏洞库未就绪）不得显示「完成：0 项发现」
        // ——那会把「没检测成」读成「查过且干净」；失败/跳过文案配合报告 degraded 横幅。
        // success/warning 视为跑完（warning 是带告警的完成）。
        const { status } = event.payload as { status: string };
        const failed = status === 'error' || status === 'unavailable' || status === 'skipped';
        progress(
          id,
          'security',
          failed
            ? t('pipeline.security.toolFailed', { tool })
            : t('pipeline.security.toolDone', {
                tool,
                count: event.payload?.issueCount as number,
              }),
          Math.min(0.9, 0.1 + toolsDone * 0.2),
        );
      }
    },
  });
  try {
    if (record.status === 'unavailable') {
      console.error('[pipeline-worker] 安全扫描异常:', record.reason);
      sendDomainOutcome(id, record);
      return;
    }
    // 先落盘再上报：页面在任务落定时会读盘刷新，写盘晚于上报会读到旧报告。
    // 映射成页面直接渲染的 SecurityScanReportData 形状（与主进程 runSecurityHandler
    // 的 toSecurityScanReportData 同一份实现，避免两套口径）。
    if (record.report !== undefined) {
      await persistSecurityReport(
        projectPath,
        toSecurityScanReportData(record.report as Parameters<typeof toSecurityScanReportData>[0]),
      );
    }
    progress(id, 'done', t('pipeline.security.done'), 1.0);
    sendDomainOutcome(id, record);
  } finally {
    // runner 持有事件总线与插件句柄，不释放会随扫描次数累积泄漏
    await runner.destroy().catch(() => undefined);
  }
}

/**
 * 垃圾清理扫描 — 垃圾清理域自有通道（T5 各司其职）。
 *
 * 组成两条来源，合并为一份 GarbageScanReport：
 *   ① 文件系统检测器（@zh/garbage detectFsGarbage）：构建产物 / 垃圾文件 / 空文件
 *   ② garbage 域 SOP 规则：死代码（ts-prune）/ 未用依赖（depcheck）
 *     （重复代码不在此列——《07》O1 已唯一归重构域）
 *
 * 不再调用安全引擎：此前为取 report.garbage 一个字段而完整跑一遍 11 工具安全扫描，
 * 属跨域借调触发权。规则通道异常不阻断，报告 checks 会带 ruleChannelRan=false 显式留痕。
 */
export async function runGarbageScanJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.scanning'), 0.1);
  const { runner } = await createLoadedRunner(projectPath);
  try {
    // 两条来源的合并、规则通道降级（partial + ruleChannelRan=false）都在 pipeline 执行器里
    const record = await runDomain('garbage', {
      repoRoot: projectPath,
      runner,
      onEvent: (event) => {
        if (event.kind === 'rule-channel-started') {
          progress(id, 'garbage', t('pipeline.garbage.ruleScanning'), 0.5);
        }
      },
    });
    const report = record.report as GarbageScanReport | undefined;
    if (!report) {
      console.error('[pipeline-worker] 垃圾扫描异常:', record.reason);
      sendDomainOutcome(id, record);
      return;
    }
    await writeGarbageSnapshot(projectPath, report);
    progress(id, 'done', t('pipeline.garbage.scanDone', { count: report.summary.total }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } finally {
    await runner.destroy().catch(() => undefined);
  }
}

/** 全量快照落盘：与 inspect/guard 等域一致，写入 .zhshield/diagnostics/domains/garbage.json；失败静默降级 */
async function writeGarbageSnapshot(projectPath: string, report: GarbageScanReport): Promise<void> {
  try {
    garbageSnapshotQueue = garbageSnapshotQueue.then(async () => {
      const dir = join(projectPath, '.zhshield', 'diagnostics', 'domains');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'garbage.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      await appendGarbageHistory(projectPath, report);
    });
    await garbageSnapshotQueue;
  } catch (err) {
    console.warn(
      '[pipeline-worker] garbage 快照落盘失败（扫描结果仍照常上报）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 垃圾清理的域级历史。
 *
 * 为什么单独一条路径：garbage 不走 `writeDomainSnapshots`（它的快照结构是
 * `items/checks/skipped`，不是归一化诊断条目），但同样需要「每次一条」的历史，
 * 否则一天扫 10 次只剩最后 30 条死代码，看不出增减。
 *
 * 指纹用 `类型 + 相对路径`（不含 reason）：reason 文案可能随规则更新变化，
 * 把文案算进指纹会让同一处垃圾每次都「新增 + 消失」各一次。
 * 该域没有 severity 概念 → `severityApplicable: false`，不用 0 冒充「都是 info」。
 */
async function appendGarbageHistory(projectPath: string, report: GarbageScanReport): Promise<void> {
  try {
    const fingerprints = report.items.map(
      (item) => `garbage:${item.type}:${normalizeFingerprint(item.path, projectPath)}`,
    );
    const ranChecks = report.checks.filter((check) => check.ran).length;
    // P2：garbage 域当场出分（garbagePenalty({total, byType})，与 dashboard-state patch
    // 同源同形；compose-on-read 同口径）。该域无 severity 概念，条目不参与计分。
    const dimensionScore = computeDomainSnapshotScore({
      dimension: 'garbage',
      garbage: { total: report.summary.total, byType: report.summary.byType },
    });
    await appendDomainHistory(
      projectPath,
      buildRecordFromFingerprints({
        domain: 'garbage',
        scannedAt: report.timestamp,
        recordedAt: new Date().toISOString(),
        fingerprints,
        total: report.summary.total,
        score: dimensionScore?.score ?? null,
        ...(dimensionScore?.version === undefined ? {} : { scoreVersion: dimensionScore.version }),
        severityApplicable: false,
        coverage: { files: ranChecks, skipped: report.skipped },
      }),
    );
  } catch (err) {
    console.warn(
      '[pipeline-worker] garbage 历史写入失败（快照已落盘）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runGarbageCleanJob(
  id: string,
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.cleaning'), 0.1);
  const { cleanGarbage } = await import('@zh/garbage');
  try {
    const result = cleanGarbage(projectPath, items);
    progress(id, 'done', t('pipeline.garbage.done', { count: result.cleaned.length }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾清理异常:', message);
    send({ type: 'error', id, error: message });
  }
}

export async function runGarbageRestoreJob(
  id: string,
  projectPath: string,
  batchId: string,
): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.restoring'), 0.1);
  const { restoreGarbage } = await import('@zh/garbage');
  try {
    const result = restoreGarbage(projectPath, batchId);
    progress(id, 'done', t('pipeline.garbage.restoreDone', { count: result.restored }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾恢复异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 自动修复备份「枚举」任务。
 *
 * 读磁盘目录 + 读清单 —— 必须在子进程：主进程禁止 fs 同步 IO（no-fs-sync 门禁），
 * 且同步扫盘会阻塞 Electron 主线程（macOS 彩球）。
 */
export async function runRefactorAutoFixBackupListJob(id: string, projectPath: string): Promise<void> {
  const { listAutoFixBackups } = await import('@zh/refactor');
  try {
    const entries = listAutoFixBackups(projectPath);
    send({ type: 'result', id, report: serializePipelineReport(entries) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 自动修复备份列举异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 自动修复「撤销」任务（按备份目录恢复）。
 *
 * 写盘动作同样离主进程。撤销失败是**用户可理解的业务结果**（不是通道故障），
 * 故以 ok=false 的结果回传，由渲染层展示原因 —— 不抛成 error 让 UI 显示红条。
 */
export async function runRefactorAutoFixRestoreJob(
  id: string,
  projectPath: string,
  backupDir: string,
): Promise<void> {
  const { restoreAutoFixBackup } = await import('@zh/refactor');
  try {
    const result = restoreAutoFixBackup(projectPath, backupDir);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 自动修复撤销异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 性能优化检测 — 性能页自有引擎单通道（@zh/performance）。
 *
 * 历史（T7 去越界）：本任务曾并跑一条「inspect 域 SOP 通道」，注释声称覆盖
 * ESLint 性能规则集 + Semgrep ReDoS。但生产 presets 中**不存在**
 * `category: performance` 的规则 —— ESLint 性能配置（kernel/assets/eslint/
 * eslint-performance.config.mjs）与 Semgrep ReDoS 规则只挂在 kernel assets
 * 与 test-fixtures，由 zhcheck / guard 路径消费。该通道因此恒产出 0 条，
 * 却要跑完整个 inspect 域（借调他域且零收益），已移除。
 *
 * 若后续要覆盖运行时反模式，应作为 @zh/performance 自有探测器落地
 * （走 ToolAdapter 共享能力），而不是回到 inspect 域 SOP 借调。
 *
 * 引擎异常不再降级吞掉：单通道下吞异常等同于把「没查到」显示成「没问题」，
 * 故直接抛出由外层转 error 事件。
 */
export async function runPerformanceJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'performance', t('pipeline.performance.loadingRules'), 0.1);
  // 纯静态分析，不执行项目代码（P0-2 禁令）；去重与报告形状归 pipeline 执行器
  const record = await runDomain('performance', { repoRoot: projectPath });
  const report = record.report as
    { summary: { total: number }; issues: PerformanceReportIssue[] } | undefined;
  if (!report) {
    console.error('[pipeline-worker] 性能检测异常:', record.reason);
    sendDomainOutcome(id, record);
    return;
  }
  progress(id, 'performance', t('pipeline.performance.scanning'), 0.6);
  progress(id, 'done', t('pipeline.performance.done', { count: report.summary.total }), 1.0);
  send({ type: 'result', id, report: serializePipelineReport(report) });
}
