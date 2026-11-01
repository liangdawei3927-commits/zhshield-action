/**
 * 依赖管家处理器（ipc/engines-deps.ts）
 *
 * engine:runDeps / engine:depsRelockBaseline：纯静态解析锁文件/清单，
 * 直连主进程，不经 TaskManager / worker。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import { t } from '@zh/i18n';
import { buildDependencyGraph, resolveProjectRoot } from '@zh/dependency';
import type { ProjectProfile } from '@zh/pipeline';
import { scanDeps, integritySnapshot } from '@zh/pipeline';
import { loadDepsBaseline, saveDepsBaseline } from './deps-baseline';
import { persistDiagnosticsFromEntries, normalizeDepsSource } from '../zh-diagnostics';
import { updateDashboardState, type DashboardDepsState } from './dashboard-state';
import { detectProfileInWorker } from '../profile-host';
import type { DiagnosticEntry } from '../zh-diagnostics-types';
import { computeDomainSnapshotScore } from '../domain-snapshot-score';
import type { DependencyReportData, DepsRelockResult } from '../../src/types/electron';
import { emptyDependencyReportData } from '../../src/services/empty-engine-reports';
import type { TaskProgressReporter } from '../task-progress';
import { runCveChecks, cveCounts } from './deps-cve';

/**
 * 从 DependencyReportData 提取 deps 域 dashboard-state patch。
 *
 * 漏洞计数提取口径（DependencyReportData 无精确 severity 字段，取最接近语义的字段）：
 * - critical = trustCounts.compromised ?? 0（被攻陷依赖节点，最高安全风险）
 * - high = trustCounts.suspicious ?? 0（可疑依赖节点，高安全风险）
 * - medium = typosquatFindings 中 risk='medium' 的投毒发现数（中等投毒风险）
 * - upgradable = upgradeAssessments 中 candidates.length > 0 的依赖数（可升级依赖）
 */
function depsDashboardPatch(report: DependencyReportData): DashboardDepsState {
  const typosquatMedium = report.typosquatFindings.filter((f) => f.risk === 'medium').length;
  const upgradable = report.upgradeAssessments.filter((a) => a.candidates.length > 0).length;
  return {
    vulnerabilities: {
      critical: report.trustCounts.compromised ?? 0,
      high: report.trustCounts.suspicious ?? 0,
      medium: typosquatMedium,
    },
    upgradable,
    // P1-8：CVE 检测结果随盘点写入。unavailable 时计数恒 0，但 status 必须随行——
    // 前端据此显示「漏洞库不可用，本次未检测」，绝不把离线呈现成 0 漏洞的安全。
    ...(report.cve
      ? { cve: { status: report.cve.status, ...cveCounts(report.cve) } }
      : {}),
    lastRunAt: new Date().toISOString(),
  };
}

/** 依赖盘点结果落盘诊断（best-effort，失败仅记录日志） */
async function persistDepsDiagnostics(
  projectPath: string,
  report: DependencyReportData,
  entries: readonly DiagnosticEntry[],
): Promise<void> {
  try {
    // P2：deps 域快照当场出分（条目 + deps 漏洞计数，与 compose-on-read 同口径）
    const patch = depsDashboardPatch(report);
    const dimensionScore = computeDomainSnapshotScore({
      dimension: 'dependencies',
      entries,
      deps: { vulnerabilities: patch.vulnerabilities, upgradable: patch.upgradable },
    });
    await persistDiagnosticsFromEntries(
      projectPath,
      entries,
      ['deps'],
      dimensionScore ? { deps: dimensionScore } : undefined,
    );
  } catch (e) {
    console.warn('[engine:runDeps] 诊断落盘失败:', e instanceof Error ? e.message : String(e));
  }
}

/** P1b: 补写 dashboard-state deps 域（漏洞 severity 计数 + 可升级数 + lastRunAt） */
async function updateDepsDashboard(
  projectPath: string,
  report: DependencyReportData,
): Promise<void> {
  await updateDashboardState(projectPath, { deps: depsDashboardPatch(report) });
}

export async function runDepsHandler(
  projectPath: string,
  onProgress?: TaskProgressReporter,
): Promise<DependencyReportData> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    onProgress?.('deps', t('pipeline.deps.loadingBaseline'), 0.05);
    const baseline = await loadDepsBaseline(projectPath);
    // 盘点装配（图谱 / 许可证 / 投毒 / 锁文件 / 升级 / 环境 / CVE）唯一实现在 pipeline
    // 的 deps 执行器；宿主只保留基线读写、CVE 网络、画像 worker 与落盘。
    onProgress?.('deps', t('pipeline.deps.buildingGraph'), 0.15);
    onProgress?.('deps', t('pipeline.deps.checking'), 0.45);
    const profile = await detectProfileSafely(projectPath);
    const { report, integrityMap } = await scanDeps(projectPath, {
      ...(baseline?.integrity ? { expectedIntegrity: baseline.integrity } : {}),
      cveProvider: (nodes) => runCveChecks(nodes),
      ...(profile ? { profile } : {}),
    });
    onProgress?.('deps', t('pipeline.deps.reporting'), 0.85);
    // 首次盘点（无基线）且校验 clean → 自动建基线（幂等；后续仅显式 relock 更新）
    if (!baseline && report.lockfileVerification.status === 'clean') {
      await saveDepsBaseline(projectPath, integrityMap);
    }
    const depsReport = report as DependencyReportData;
    await persistDepsDiagnostics(projectPath, depsReport, normalizeDepsSource(depsReport));
    await updateDepsDashboard(projectPath, depsReport);
    return depsReport;
  } catch (err) {
    console.error('[engine:runDeps] Error:', err);
    return emptyDependencyReportData(err instanceof Error ? err.message : String(err));
  }
}

/** 画像探测移到 profile worker（同步扫盘不落主进程）；失败降级为 undefined（由引擎自行同步探测） */
async function detectProfileSafely(projectPath: string): Promise<ProjectProfile | undefined> {
  try {
    return (await detectProfileInWorker(projectPath)) as ProjectProfile;
  } catch (err) {
    console.warn(
      '[engine:runDeps] 项目画像探测失败，降级为引擎内同步探测:',
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}

/** 显式重锁基线：仅当锁文件哈希完整（integrityVerified，全部节点带哈希）时才允许，防止把残缺哈希锁成基线 */
export async function depsRelockBaselineHandler(projectPath: string): Promise<DepsRelockResult> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const projectRoot = resolveProjectRoot(projectPath);
    const graph = buildDependencyGraph(projectRoot);
    if (!graph.lockfile.integrityVerified) {
      return { ok: false, error: t('electron.depsRelock.integrityIncomplete') };
    }
    await saveDepsBaseline(projectRoot, integritySnapshot(graph.nodes));
    return { ok: true };
  } catch (err) {
    console.error('[engine:depsRelockBaseline] Error:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
