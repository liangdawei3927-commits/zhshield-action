/**
 * 依赖管家处理器（ipc/engines-deps.ts）
 *
 * engine:runDeps / engine:depsRelockBaseline：纯静态解析锁文件/清单，
 * 直连主进程，不经 TaskManager / worker。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import { t } from '@zh/i18n';
import type {
  DependencyNode,
  DependencyGraph,
  TyposquatFinding,
  LockfileVerification,
  UpgradeAssessment,
  EnvEntry,
} from '@zh/dependency';
import {
  buildDependencyGraph,
  buildLicenseMatrix,
  lockfileVerifier,
  resolveProjectRoot,
  TyposquatDetectorImpl,
  UpgradeEvaluatorImpl,
  EnvConsistencyCheckerImpl,
  DEFAULT_UPGRADE_CATALOG,
} from '@zh/dependency';
import type { ProjectProfile } from '@zh/pipeline';
import {
  loadDepsBaseline,
  saveDepsBaseline,
  integritySnapshot,
  extractMismatchedNodeIds,
  applyMismatchedTrust,
} from './deps-baseline';
import { persistDiagnosticsFromEntries, normalizeDepsSource } from '../zh-diagnostics';
import { updateDashboardState, type DashboardDepsState } from './dashboard-state';
import { detectProfileInWorker } from '../profile-host';
import type { DependencyReportData, DepsRelockResult } from '../../src/types/electron';
import { emptyDependencyReportData } from '../../src/services/empty-engine-reports';
import type { TaskProgressReporter } from '../task-progress';
import { runCveChecks, cveCounts, type CveCheckResult } from './deps-cve';

/** 按信任状态统计节点数（verified / suspicious / compromised / unknown） */
function countTrustCounts(nodes: DependencyNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.trust] = (counts[node.trust] ?? 0) + 1;
  }
  return counts;
}

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

/**
 * 依赖管家（engine:runDeps）：纯静态解析锁文件/清单，直连主进程，
 * 不经 TaskManager / worker。返回依赖图谱 + 许可证矩阵 + 投毒检测 +
 * 锁文件校验 + 升级评估 + 环境一致性报告。
 */
type DepsChecks = {
  typosquat: { findings: TyposquatFinding[]; error?: string };
  lockfileCheck: { verification: LockfileVerification; mismatchedNodeIds: string[]; error?: string };
  upgrade: { assessments: UpgradeAssessment[]; error?: string };
  env: { entries: EnvEntry[]; error?: string };
  /** P1-8：CVE 检测（OSV 数据源；不可达时 status='unavailable'，绝不静默 0） */
  cve: CveCheckResult;
};

/** 组装依赖盘点报告（含各检查结果与错误透传） */
function buildDepsReport(
  graph: DependencyGraph,
  matrix: ReturnType<typeof buildLicenseMatrix>,
  nodes: DependencyNode[],
  checks: DepsChecks,
): DependencyReportData {
  const { typosquat, lockfileCheck, upgrade, env, cve } = checks;
  return {
    schemaVersion: graph.schemaVersion,
    targetId: graph.targetId,
    ecosystem: graph.ecosystem,
    direct: nodes.filter((node: { kind: string }) => node.kind === 'direct').length,
    transitive: nodes.filter((node: { kind: string }) => node.kind === 'transitive').length,
    total: nodes.length,
    edgeCount: graph.edges.length,
    lockfile: graph.lockfile,
    trustCounts: countTrustCounts(nodes),
    licenseMatrix: matrix,
    generatedAt: graph.generatedAt,
    error: null,
    typosquatFindings: typosquat.findings,
    lockfileVerification: lockfileCheck.verification,
    upgradeAssessments: upgrade.assessments,
    envEntries: env.entries,
    cve,
    ...(typosquat.error ? { typosquatError: typosquat.error } : {}),
    ...(lockfileCheck.error ? { lockfileError: lockfileCheck.error } : {}),
    ...(upgrade.error ? { upgradeError: upgrade.error } : {}),
    ...(env.error ? { envError: env.error } : {}),
  };
}

/** 依赖盘点结果落盘诊断（best-effort，失败仅记录日志） */
async function persistDepsDiagnostics(
  projectPath: string,
  report: DependencyReportData,
): Promise<void> {
  try {
    await persistDiagnosticsFromEntries(projectPath, normalizeDepsSource(report), ['deps']);
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
    const projectRoot = resolveProjectRoot(projectPath);
    const baseline = await loadDepsBaseline(projectRoot);
    onProgress?.('deps', t('pipeline.deps.buildingGraph'), 0.15);
    const graph = buildDependencyGraph(projectRoot);
    const matrix = buildLicenseMatrix(graph);
    let nodes = graph.nodes;
    onProgress?.('deps', t('pipeline.deps.checking'), 0.45);
    const [typosquat, lockfileCheck, upgrade, env, cve] = await Promise.all([
      runTyposquatChecks(graph),
      runLockfileChecks(projectRoot, baseline?.integrity),
      runUpgradeChecks(nodes),
      runEnvConsistencyChecks(projectRoot),
      runCveChecks(nodes),
    ]);
    onProgress?.('deps', t('pipeline.deps.reporting'), 0.85);
    // 与基线哈希不符的节点 → 最高危 trust（须在 countTrustCounts 之前覆盖；浅拷贝替换，不原地改）
    // mismatchedNodeIds 由 verify() 的 actual !== undefined 语义保证：仅同版本哈希真实改变才命中，
    // 升级（版本号变化）天然免疫，不误报。
    nodes = applyMismatchedTrust(nodes, lockfileCheck.mismatchedNodeIds);
    // 首次盘点（无基线）且校验 clean → 自动建基线（幂等；后续仅显式 relock 更新）
    if (!baseline && lockfileCheck.verification.status === 'clean') {
      await saveDepsBaseline(projectRoot, integritySnapshot(nodes));
    }
    const report = buildDepsReport(graph, matrix, nodes, {
      typosquat,
      lockfileCheck,
      upgrade,
      env,
      cve,
    });
    await persistDepsDiagnostics(projectPath, report);
    await updateDepsDashboard(projectPath, report);
    return report;
  } catch (err) {
    console.error('[engine:runDeps] Error:', err);
    return emptyDependencyReportData(err instanceof Error ? err.message : String(err));
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

/** 投毒检测接线：单适配器失败 → 空数组 + error，不阻断整个盘点 */
async function runTyposquatChecks(
  graph: DependencyGraph,
): Promise<{ findings: TyposquatFinding[]; error?: string }> {
  try {
    const detector = new TyposquatDetectorImpl();
    return { findings: await detector.detect(graph) };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 投毒检测失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 锁文件完整性校验接线：校验器契约不抛异常，兜底为 missing + error；返回与基线哈希不符的节点 id 列表 */
async function runLockfileChecks(
  projectPath: string,
  expectedIntegrity?: Record<string, string>,
): Promise<{ verification: LockfileVerification; mismatchedNodeIds: string[]; error?: string }> {
  try {
    const verification = await lockfileVerifier.verify(
      projectPath,
      expectedIntegrity ? { expectedIntegrity } : undefined,
    );
    return {
      verification,
      mismatchedNodeIds: extractMismatchedNodeIds(verification.integrityFailures),
    };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 锁文件校验失败:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      verification: { status: 'missing', diffs: [], integrityFailures: [] },
      mismatchedNodeIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 升级评估接线：仅 direct 依赖且命中内置升级目录，不做 code-scan 防主进程阻塞 */
async function runUpgradeChecks(
  nodes: readonly DependencyNode[],
): Promise<{ assessments: UpgradeAssessment[]; error?: string }> {
  try {
    const evaluator = new UpgradeEvaluatorImpl();
    const directNodes = nodes.filter(
      (node) => node.kind === 'direct' && node.name in DEFAULT_UPGRADE_CATALOG,
    );
    const assessments: UpgradeAssessment[] = [];
    for (const node of directNodes) {
      assessments.push(await evaluator.evaluate(node));
    }
    return { assessments };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 升级评估失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { assessments: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 环境一致性检查接线：从 projectPath 推导 ProjectProfile（detectProjectProfile 同步 fs，移入 profile worker 执行） */
async function runEnvConsistencyChecks(
  projectPath: string,
): Promise<{ entries: EnvEntry[]; error?: string }> {
  try {
    const checker = new EnvConsistencyCheckerImpl();
    const profile = (await detectProfileInWorker(projectPath)) as ProjectProfile;
    const report = await checker.check(profile);
    return { entries: report.entries };
  } catch (err) {
    console.warn(
      '[engine:runDeps] 环境一致性检查失败:',
      err instanceof Error ? err.message : String(err),
    );
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}
