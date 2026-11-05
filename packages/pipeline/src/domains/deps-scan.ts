/**
 * 依赖管家域的**纯装配**（《07》O10：依赖包 CVE / 许可证 / 锁文件 / 投毒 / 升级 唯一归 deps）。
 *
 * 为什么放在 pipeline 而不是桌面接线层：依赖盘点是域职责，不是宿主能力。
 * 此前它整段写在 `desktop/electron/ipc/engines-deps.ts`（主进程直连），
 * 结果 CLI / 无头流水线根本没有 deps 域可跑（A14 无法复测）。
 * 下沉后宿主只保留三件真正的宿主事务：基线读写（`.zhshield/deps-baseline.json`）、
 * CVE 网络查询、诊断落盘 / 仪表盘。
 *
 * 网络与画像走注入：OSV 查询与项目画像在桌面端有各自的宿主实现（fetch 注入 / worker
 * 线程），此处只声明"我需要什么"，不把网络策略和线程模型带进编排层。
 */
import {
  buildDependencyGraph,
  buildLicenseMatrix,
  lockfileVerifier,
  resolveProjectRoot,
  TyposquatDetectorImpl,
  UpgradeEvaluatorImpl,
  EnvConsistencyCheckerImpl,
  DEFAULT_UPGRADE_CATALOG,
  type DependencyNode,
  type DependencyGraph,
  type EnvEntry,
  type LockfileVerification,
  type TyposquatFinding,
  type UpgradeAssessment,
} from '@zh/dependency';
import { detectProjectProfile, type ProjectProfile } from '../project-profile';

/** OSV 命中的单条依赖漏洞（与桌面端 CveFinding 同形） */
export interface DepsCveFinding {
  name: string;
  version: string;
  /** 漏洞标识（CVE/GHSA 别名），多条以「, 」连接 */
  ids: string;
  summary: string;
  severity: 'critical' | 'high' | 'medium';
}

/**
 * CVE 检查结果。`unavailable` = 漏洞库不可达，本次**未检测**（≠ 0 漏洞，C4）。
 */
export interface DepsCveResult {
  status: 'ok' | 'unavailable';
  findings: DepsCveFinding[];
  reason?: string;
  checkedAt: string;
}

/** 依赖盘点所需的宿主注入项 */
export interface DepsScanInput {
  /** 锁文件完整性基线（宿主从 `.zhshield/deps-baseline.json` 读出后注入） */
  expectedIntegrity?: Record<string, string>;
  /** CVE 查询（网络）。缺省 = 本次未检测，报告里显式标注 unavailable */
  cveProvider?: (nodes: readonly DependencyNode[]) => Promise<DepsCveResult>;
  /** 项目画像（桌面端在 worker 线程探测）；缺省本层同步探测 */
  profile?: ProjectProfile;
}

/** 依赖盘点报告（镜像桌面端 `DependencyReportData` 的可序列化形状） */
export interface DepsScanReport {
  schemaVersion: number;
  targetId: string;
  ecosystem: string;
  direct: number;
  transitive: number;
  total: number;
  edgeCount: number;
  lockfile: DependencyGraph['lockfile'];
  trustCounts: Record<string, number>;
  licenseMatrix: ReturnType<typeof buildLicenseMatrix>;
  typosquatFindings: TyposquatFinding[];
  lockfileVerification: LockfileVerification;
  upgradeAssessments: UpgradeAssessment[];
  envEntries: EnvEntry[];
  cve: DepsCveResult;
  generatedAt: string;
  error: null;
  typosquatError?: string;
  lockfileError?: string;
  upgradeError?: string;
  envError?: string;
}

/** 盘点结果：报告 + 本次实测的完整性快照（宿主首次盘点建基线时用） */
export interface DepsScanResult {
  report: DepsScanReport;
  /** 节点 id(name@version) → integrity，仅含带哈希的节点 */
  integrityMap: Record<string, string>;
}

/** 按信任状态统计节点数 */
function countTrustCounts(nodes: readonly DependencyNode[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.trust] = (counts[node.trust] ?? 0) + 1;
  }
  return counts;
}

/** 完整性失败消息形如 `[direct] lodash@4.17.21 校验和不匹配：期望 …，实际 …` */
const MISMATCHED_INTEGRITY_RE = /^\[[^\]]*\] (\S+) 校验和不匹配/;

/** 从完整性失败清单提取被篡改（哈希真实改变）的节点 id */
export function extractMismatchedNodeIds(integrityFailures: readonly string[]): string[] {
  const ids: string[] = [];
  for (const message of integrityFailures) {
    const match = MISMATCHED_INTEGRITY_RE.exec(message);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** 将被篡改节点覆盖为最高危 trust（浅拷贝替换，不原地修改） */
export function applyMismatchedTrust(
  nodes: readonly DependencyNode[],
  mismatchedNodeIds: readonly string[],
): DependencyNode[] {
  if (mismatchedNodeIds.length === 0) return [...nodes];
  const mismatched = new Set(mismatchedNodeIds);
  return nodes.map((node) => (mismatched.has(node.id) ? { ...node, trust: 'compromised' } : node));
}

/** 节点 id → integrity 快照（仅含带哈希的节点） */
export function integritySnapshot(nodes: readonly DependencyNode[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of nodes) {
    if (node.integrity !== undefined) map[node.id] = node.integrity;
  }
  return map;
}

async function runTyposquatChecks(
  graph: DependencyGraph,
): Promise<{ findings: TyposquatFinding[]; error?: string }> {
  try {
    return { findings: await new TyposquatDetectorImpl().detect(graph) };
  } catch (err) {
    return { findings: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 锁文件校验：校验器契约不抛异常；兜底为 missing + error，并返回与基线不符的节点 */
async function runLockfileChecks(
  projectRoot: string,
  expectedIntegrity?: Record<string, string>,
): Promise<{ verification: LockfileVerification; mismatchedNodeIds: string[]; error?: string }> {
  try {
    const verification = await lockfileVerifier.verify(
      projectRoot,
      expectedIntegrity ? { expectedIntegrity } : undefined,
    );
    return {
      verification,
      mismatchedNodeIds: extractMismatchedNodeIds(verification.integrityFailures),
    };
  } catch (err) {
    return {
      verification: { status: 'missing', diffs: [], integrityFailures: [] },
      mismatchedNodeIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 升级评估：仅 direct 且命中内置升级目录（不拉 registry，避免慢网络拖垮域预算） */
async function runUpgradeChecks(
  nodes: readonly DependencyNode[],
): Promise<{ assessments: UpgradeAssessment[]; error?: string }> {
  try {
    const evaluator = new UpgradeEvaluatorImpl();
    const direct = nodes.filter(
      (node) => node.kind === 'direct' && node.name in DEFAULT_UPGRADE_CATALOG,
    );
    const assessments: UpgradeAssessment[] = [];
    for (const node of direct) assessments.push(await evaluator.evaluate(node));
    return { assessments };
  } catch (err) {
    return { assessments: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 环境一致性：清单 vs profile（缺 profile 时同步探测，探测失败降级为空 + error） */
async function runEnvConsistencyChecks(
  projectRoot: string,
  profile?: ProjectProfile,
): Promise<{ entries: EnvEntry[]; error?: string }> {
  try {
    const resolved = profile ?? detectProjectProfile(projectRoot);
    return { entries: (await new EnvConsistencyCheckerImpl().check(resolved)).entries };
  } catch (err) {
    return { entries: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 跑一次依赖盘点。
 *
 * @param repoRoot 项目根（内部再经 `resolveProjectRoot` 归一，与桌面端一致）
 */
export async function scanDeps(
  repoRoot: string,
  input: DepsScanInput = {},
): Promise<DepsScanResult> {
  const projectRoot = resolveProjectRoot(repoRoot);
  const graph = buildDependencyGraph(projectRoot);
  const matrix = buildLicenseMatrix(graph);
  const [typosquat, lockfileCheck, upgrade, env] = await Promise.all([
    runTyposquatChecks(graph),
    runLockfileChecks(projectRoot, input.expectedIntegrity),
    runUpgradeChecks(graph.nodes),
    runEnvConsistencyChecks(projectRoot, input.profile),
  ]);
  // 篡改节点必须在 countTrustCounts 之前覆盖（浅拷贝替换，不原地改）
  const nodes = applyMismatchedTrust(graph.nodes, lockfileCheck.mismatchedNodeIds);
  const cve = await resolveCve(nodes, input.cveProvider);

  const report: DepsScanReport = {
    schemaVersion: graph.schemaVersion,
    targetId: graph.targetId,
    ecosystem: graph.ecosystem,
    direct: nodes.filter((node) => node.kind === 'direct').length,
    transitive: nodes.filter((node) => node.kind === 'transitive').length,
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
  return { report, integrityMap: integritySnapshot(nodes) };
}

/** CVE：无 provider 即显式 unavailable（绝不静默 0 漏洞） */
async function resolveCve(
  nodes: readonly DependencyNode[],
  provider?: DepsScanInput['cveProvider'],
): Promise<DepsCveResult> {
  if (!provider) {
    return {
      status: 'unavailable',
      findings: [],
      reason: '未注入 CVE 查询（无网络/无头运行），本次未检测依赖漏洞',
      checkedAt: new Date().toISOString(),
    };
  }
  try {
    return await provider(nodes);
  } catch (err) {
    return {
      status: 'unavailable',
      findings: [],
      reason: err instanceof Error ? err.message : String(err),
      checkedAt: new Date().toISOString(),
    };
  }
}
