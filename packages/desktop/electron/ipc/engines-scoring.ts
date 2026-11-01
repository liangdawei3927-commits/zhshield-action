/**
 * 评分 / 画像处理器（ipc/engines-scoring.ts）
 *
 * 健康评分写分点、模块级评分与项目画像缓存；只读处理器（评分读取 / 分类页实时评分 /
 * 报告中心总览 / 治理域快照 / 项目画像查询）见 engines-scoring-read.ts。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import { t } from '@zh/i18n';
import { buildHealthDimensions, computeRedLine, scoreProjectByModules } from '@zh/scoring';
import type { ConvertedGuardResult, ConvertedInspectIssue } from '@zh/scoring';
import { listGuardReports } from '@zh/guard';
import type { GuardReport } from '@zh/guard';
import type { PipelineReport } from '@zh/pipeline';
import type { ScoringProjectProfile } from '@zh/fingerprint';
import { convertTraditionalGuardResults } from './score-converters';
import { loadBackupHealthSnapshot } from './backup';
import { getSentinelHealthData } from './sentinel';
import { readDomainSnapshot } from '../zh-diagnostics';
import { readDashboardState } from './dashboard-state';
import {
  getScoring,
  setCachedProfile,
  registerProjectFeaturesToCloud,
  type CachedProjectFeature,
} from '../ipc-context';
import { runProfileSyncInWorker, runProfileInWorker } from '../profile-host';
import { toHealthScoreData, type HealthScoreData } from './report-format';
import { assembleHealthInputs, hasAnyExtraResult, type PipelineExtras } from '../report-summary';

/**
 * 模块级独立评分：跳过根级兜底卡（id === projectPath），各模块用自身类型权重评分后逐模块落库。
 *
 * 落库键用 `card.id`（绝对路径）而非 `card.path`（相对路径）：
 * `packages/ui` 这类相对路径在两个 monorepo 之间会撞车，写进同一行记录、历史互相污染。
 */
function scoreProjectModules(
  scoring: Awaited<ReturnType<typeof getScoring>>,
  aggregate: ReturnType<typeof scoreProjectByModules>,
  projectPath: string,
): void {
  for (const card of aggregate.modules) {
    if (card.id === projectPath) continue;
    const moduleScore = scoring.calculate(card.id, card.dimensions);
    console.log(
      `[engine:runPipeline] 模块评分已落库: ${card.id} ${moduleScore.overall} (${moduleScore.grade})`,
    );
  }
}

/** 评分输入的已解析报告形态（engines.ts 的 resolvePipelineReports 返回值契约） */
export type ResolvedPipelineReports = {
  isSop: boolean;
  guardResults: ConvertedGuardResult[];
  inspectIssues: ConvertedInspectIssue[];
};

/** 探测项目画像，失败时降级为 null（采用默认评分配置） */
export async function probeProjectProfile(
  projectPath: string,
): Promise<ScoringProjectProfile | null> {
  try {
    const profile = (await runProfileSyncInWorker(projectPath)).profile;
    cacheProfile(profile, projectPath);
    return profile;
  } catch (err) {
    console.warn(
      '[engine:runPipeline] 画像探测失败，降级默认评分配置:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 将探测到的项目画像投影为 kernel 兼容的 ProjectFeature 并写入画像缓存（供工具规则按画像裁剪） */
export function cacheProfile(profile: ScoringProjectProfile, projectPath?: string): void {
  const features: string[] = [];
  if (profile.type && profile.type !== 'unknown') features.push(String(profile.type));
  if (profile.runtime && profile.runtime !== 'unknown') features.push(String(profile.runtime));
  if (profile.isMonorepo) features.push('modular-monolith');
  const feature: CachedProjectFeature = {
    language: profile.language === 'unknown' ? undefined : profile.language,
    framework: profile.framework,
    features,
  };
  setCachedProfile(feature, projectPath);
  if (projectPath) {
    void registerProjectFeaturesToCloud(feature, projectPath);
  }
}

/**
 * 汇总评分输入，并判定「是否至少有一个域出过结果」。
 *
 * 「写分」与「总览」两条入口此前各自复制同一段输入组装 + hasResults 判定。
 * 复制品一旦分叉就会重现 2026-10-24 那两个分的故障（同一时刻写出两个总分），
 * 故收敛为唯一实现：两条入口结构上不可能既不同源又都正确。
 */
export async function collectScoringInputs(projectPath: string) {
  const inputs = await assembleHealthInputs(projectPath, {
    listGuardReports,
    readDomainSnapshot,
    readDashboardState,
    buildPipelineExtras,
  });
  const hasResults =
    inputs.guard !== null || inputs.inspectIssues !== null || hasAnyExtraResult(inputs.extras);
  return { inputs, hasResults };
}

/**
 * 写分点 1/2（已合并为一个函数）：把各域最新落盘结果汇总成健康总分并落库。
 *
 * 🔴 2026-10-24 修正：原先「pipeline 跑完写分」消费**内存里的本次报告**，
 * 「报告中心汇总」消费**磁盘上的最新快照** —— 同一时刻两条路径能写出两个分
 * （实测：inspect 快照落盘 quality=80.2，同一分钟的 scores 记录里写的是 95），
 * 历史趋势因此在 98.1 / 94.1 / 95 / 81 / 80.2 之间反复横跳，用户看到的
 * 「卡片与分类页对不上」有一半来自这里。
 *
 * 现在两条路径调用**同一个函数、同一份输入**（`assembleHealthInputs`），
 * 与分类页实时评分也是同一份输入 ⇒ 三者结构上不可能漂移。pipeline 路径同样读盘是
 * 安全的：`persistDiagnostics` 先于本函数执行（runPipelineHandler 406→416），
 * 本次结果已落盘后再汇总。
 *
 * 各域都没有可用结果时返回 null：不写一条 0 分记录污染历史（未检测 ≠ 0 分）。
 */
export async function summarizeAndPersistScore(
  projectPath: string,
): Promise<HealthScoreData | null> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  // 输入组装与分类页实时评分共用 assembleHealthInputs（含 Q4 评分输入缺口修复：
  // security/deps 专用扫描发现并入），两条路径结构上不可能漂移。
  const { inputs, hasResults } = await collectScoringInputs(projectPath);
  if (!hasResults) return null;

  const scoring = await getScoring();
  const profilingResult = await probeProjectProfile(projectPath);
  const dimensions = buildHealthDimensions({
    guard: inputs.guard,
    inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues, esloc: inputs.esloc } : null,
    projectRoot: projectPath,
    profile: profilingResult,
    extras: inputs.extras,
  });
  const score = scoring.calculate(projectPath, dimensions, computeRedLine(inputs.extras));
  return toHealthScoreData(score);
}

/**
 * 体检（pipeline）完成后的写分。
 *
 * 与报告中心「生成报告」走同一个 `summarizeAndPersistScore`：都是「各域最新落盘结果
 * 的汇总」，不存在第二条算分路径。模块级评分仍消费本次报告（模块分不落库到总分）。
 */
export async function computePipelineHealthScore(projectPath: string): Promise<void> {
  await summarizeAndPersistScore(projectPath);
}

interface ScorePipelineModulesParams {
  projectPath: string;
  report: PipelineReport;
  resolved: ResolvedPipelineReports;
  profilingResult: ScoringProjectProfile | null;
  scoring: Awaited<ReturnType<typeof getScoring>>;
}

/** 模块级独立评分：跳过根级兜底卡，各模块用自身类型权重评分后逐模块落库 */
export async function scorePipelineModules(params: ScorePipelineModulesParams): Promise<void> {
  const { projectPath, report, resolved, profilingResult, scoring } = params;
  if (!profilingResult?.modules?.length) return;
  const moduleGuardResults = resolved.isSop
    ? resolved.guardResults
    : convertTraditionalGuardResults((report.guard as GuardReport).results);
  const aggregate = scoreProjectByModules(
    profilingResult,
    { results: moduleGuardResults },
    { issues: resolved.inspectIssues },
  );
  scoreProjectModules(scoring, aggregate, projectPath);
}

// ─── 报告中心：只读汇总（不发起任何检查）──────────────────────────────

/**
 * 写分点 2/2：报告中心「汇总生成报告」——只读各域最新落盘结果，按统一维度加权算健康总分并落库。
 *
 * 与 recordPipelineScore 唯一的区别是数据来源：
 * - recordPipelineScore 消费刚跑完的 PipelineReport（由 pipeline 触发）；
 * - 本函数消费 guard 报告记录 + .zhshield/diagnostics/domains/inspect.json +
 *   dashboard-state.json，**纯只读，不触发任何扫描**。
 * 评分算法（buildHealthDimensions + ScoringEngine.calculate）完整复用，
 * 保证两条路径写出的分数同口径、历史趋势连续。
 *
 * 各域都没有可用结果时返回 null，由 UI 提示「先运行检查」——
 * 不写一条 0 分记录污染历史（未检测 ≠ 0 分）。
 */
export async function generateReportSummaryHandler(
  projectPath: string,
): Promise<HealthScoreData | null> {
  try {
    return await summarizeAndPersistScore(projectPath);
  } catch (err) {
    console.warn(
      '[engine:generateReportSummary] 汇总失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─── 仪表盘聚合（P1b）─────────────────────────────────────────────

/** 从 dashboard-state.json + 哨兵事件中心 + 备份记录组装 extras（无对应域时传 null） */
export async function buildPipelineExtras(projectPath: string): Promise<PipelineExtras> {
  const state = await readDashboardState(projectPath);
  const [sentinel, backup] = await Promise.all([
    getSentinelHealthData(projectPath).catch(() => null),
    loadBackupHealthSnapshot(projectPath).catch(() => null),
  ]);
  return {
    secrets: state.secrets ? { activeCount: state.secrets.activeCount } : null,
    deps: state.deps
      ? { vulnerabilities: state.deps.vulnerabilities, upgradable: state.deps.upgradable }
      : null,
    techdebt: state.techdebt
      ? { debtIndex: state.techdebt.debtIndex, issueCount: state.techdebt.issueCount }
      : null,
    refactor: state.refactor
      ? {
          totalSmells: state.refactor.totalSmells,
          bySeverity: state.refactor.bySeverity,
          ...(state.refactor.scannedFiles !== undefined
            ? { scannedFiles: state.refactor.scannedFiles }
            : {}),
        }
      : null,
    performance: state.performance
      ? { total: state.performance.total, bySeverity: state.performance.bySeverity }
      : null,
    garbage: state.garbage
      ? { total: state.garbage.total, byType: state.garbage.byType }
      : null,
    sentinel,
    backup,
  };
}

/**
 * 将 @zh/fingerprint profileProject 结果投影为画像缓存并触发 T0 云端注册。
 * onboarding 第 1 步（engine:runProfile）探测后立即调用，
 * 使第 2 步 syncRules 能读到画像做按需裁剪（否则退化为全量 4 工具同步）。
 */
export function cacheProfileFromFingerprintResult(result: unknown, projectPath: string): void {
  try {
    const { profile } = (result ?? {}) as { profile?: import('@zh/fingerprint').ProjectProfile };
    const target = profile?.targets?.[0];
    if (!target) {
      console.warn('[engine:runProfile] 画像无 targets，跳过缓存（同步保持全量）');
      return;
    }
    const features: string[] = [];
    const productForm = target.productForm;
    if (productForm?.value) features.push(String(productForm.value));
    // architecture / environments 挂在 ProjectProfile 上而非 TargetProfile：原代码用
    // 宽松类型断言掩盖了这个错位，两次读取恒为 undefined → 这两类特征从未进入缓存。
    const arch = profile?.architecture;
    if (arch?.value) features.push(String(arch.value));
    for (const e of profile?.environments ?? []) {
      if (e?.value) features.push(String(e.value));
    }
    const feature: CachedProjectFeature = {
      language: target.language?.value,
      framework: target.frameworks?.[0]?.value,
      features,
    };
    setCachedProfile(feature, projectPath);
    void registerProjectFeaturesToCloud(feature, projectPath);
    console.log(
      `[engine:runProfile] 画像已缓存: language=${feature.language ?? 'unknown'} framework=${feature.framework ?? 'unknown'}`,
    );
  } catch (err) {
    console.warn(
      '[engine:runProfile] 画像缓存失败（不影响探测结果返回）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runProfileHandler(projectPath: string): Promise<unknown> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  // 画像探测含全量同步扫盘（@zh/fingerprint detectors），必须离主进程，否则 macOS 彩球
  const result = await runProfileInWorker(projectPath);
  cacheProfileFromFingerprintResult(result, projectPath);
  return result;
}
