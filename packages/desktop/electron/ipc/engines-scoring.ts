/**
 * 评分 / 画像 / 报告中心处理器（ipc/engines-scoring.ts）
 *
 * 健康评分写分点、分类页实时评分、报告中心只读汇总与项目画像缓存。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import path from 'node:path';
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
import type { DiagnosticSource, DiagnosticsReport } from '../zh-diagnostics-types';
import { readDashboardState } from './dashboard-state';
import {
  getScoring,
  setCachedProfile,
  registerProjectFeaturesToCloud,
  type CachedProjectFeature,
} from '../ipc-context';
import { runProfileSyncInWorker, runProfileInWorker } from '../profile-host';
import { toHealthScoreData, type HealthScoreData } from './report-format';
import type { DomainScoreData, ProjectProfileData } from '../../src/types/electron';
import {
  assembleHealthInputs,
  hasAnyExtraResult,
  isScoreDimension,
  qualityFastPathScore,
  type PipelineExtras,
  type ScoreDimension,
} from '../report-summary';

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
function cacheProfile(profile: ScoringProjectProfile, projectPath?: string): void {
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
 * 写分点 1/2：体检完成后将 guard + inspect 报告转化为健康维度分并落库。
 *
 * 🔴 落分口径铁律（T14）：健康总分在全仓**只有两个写分点** ——
 *   ① 本函数：消费刚跑完的 PipelineReport（真实发起检查后落分）
 *   ② `generateReportSummaryHandler`：只读各域最近落盘结果汇总（报告中心）
 * 两者必须共用 `buildHealthDimensions` + `ScoringEngine.calculate`，
 * 否则同一时刻两条路径会写出两个分，历史趋势断裂。
 * 另：总分是**对已有结果的汇总**而非实时值，UI 侧由 `scoreFreshness` 标注数据时间。
 *
 * 支持两种报告格式：
 * 1. 传统格式：GuardReport（有 results）+ InspectionReport（有 issues）
 * 2. SOP 格式：RuleEngineReport（有 evaluations）— 需要转换
 */
/** 组装评分输入并计算健康总分（P1b extras + S2 esloc 同口径），落库并记录日志 */
export async function computePipelineHealthScore(
  projectPath: string,
  resolved: ResolvedPipelineReports,
  profilingResult: ScoringProjectProfile | null,
  scoring: Awaited<ReturnType<typeof getScoring>>,
): Promise<void> {
  // P1b: 从 dashboard-state.json 读取 secrets/deps/techdebt/refactor/performance 最新数据组装 extras，
  // 传入 buildHealthDimensions 第 5 参（DimensionExtras 契约），保证 pipeline 分与 dashboard 分一致。
  const extras = await buildPipelineExtras(projectPath);
  // S2 密度归一化分母：persistDiagnostics 先于本函数执行（runPipelineHandler 1399→1409），
  // 快照已存落盘口径的 esloc，读同一值保证两条写分路径同口径。
  const esloc = (await readDomainSnapshot(projectPath, 'inspect'))?.esloc;
  const dimensions = buildHealthDimensions({
    guard: { results: resolved.guardResults },
    inspect: { issues: resolved.inspectIssues, esloc },
    projectRoot: projectPath,
    profile: profilingResult,
    extras,
  });
  const score = scoring.calculate(projectPath, dimensions, computeRedLine(extras));
  console.log(`[engine:runPipeline] 健康评分已落库: ${score.overall} (${score.grade})`);
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
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    // 输入组装与分类页实时评分共用 assembleHealthInputs（含 Q4 评分输入缺口修复：
    // security/deps 专用扫描发现并入），两条路径结构上不可能漂移。
    const inputs = await assembleHealthInputs(projectPath, {
      listGuardReports,
      readDomainSnapshot,
      readDashboardState,
      buildPipelineExtras,
    });
    const hasResults =
      inputs.guard !== null || inputs.inspectIssues !== null || hasAnyExtraResult(inputs.extras);
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
    console.log(`[engine:generateReportSummary] 汇总评分已落库: ${score.overall} (${score.grade})`);
    return toHealthScoreData(score);
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
      ? { totalSmells: state.refactor.totalSmells, bySeverity: state.refactor.bySeverity }
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

export async function getScoreHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectId: string,
): Promise<HealthScoreData | null> {
  try {
    const scoring = await getScoring();
    const score = scoring.getCurrent(projectId);
    return score ? toHealthScoreData(score) : null;
  } catch (err) {
    console.warn(
      '[engine:getScore] 评分读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export async function getScoreHistoryHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectId: string,
): Promise<HealthScoreData[]> {
  try {
    const scoring = await getScoring();
    return scoring.getHistory(projectId).map(toHealthScoreData);
  } catch (err) {
    console.warn(
      '[engine:getScoreHistory] 评分历史读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * 分类页实时评分返回：generatedAt 允许 null（该域无时间锚点时由渲染层回退汇总）。
 */
type DomainScoreDataLike = Omit<DomainScoreData, 'generatedAt'> & { generatedAt: string | null };

/**
 * 分类页实时评分（engine:getDomainScore）：按维度实时算分，只读不算。
 *
 * 只读不算：绝不调用 calculate（会写库，批 6/铁律）——本路径只调
 * buildHealthDimensions 直接算该维分数，不落库、不写任何快照。
 *
 * - quality 走快照快路径：inspect 快照落盘时已当场出分（含 previousScore 对比基线），
 *   直接透传，保持既有语义与 e2e；但 performance 条目落在自己的域快照里，
 *   故一并读入并由 qualityFastPathScore 合并后重算（无 performance 条目时仍是零算分）。
 * - 其余 9 维 compose-on-read：与报告中心汇总共用 assembleHealthInputs 组装输入，
 *   保证两条路径同口径、结构上不可能漂移；维度分与权重无关，故不传 profile。
 */
/**
 * 读某治理域最近一次落盘快照（仅问题项）。
 *
 * 供分类页「有历史评分即可查看详情」使用：无快照/损坏返回 null，
 * 由 UI 自行决定是否渲染详情入口 —— 不得据 null 宣称「该域无问题」。
 */
export async function getDomainReportHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  source: DiagnosticSource,
): Promise<DiagnosticsReport | null> {
  try {
    if (!projectPath || typeof projectPath !== 'string') return null;
    return await readDomainSnapshot(projectPath, source);
  } catch {
    return null;
  }
}

export async function getDomainScoreHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
  dimension: ScoreDimension,
): Promise<DomainScoreDataLike | null> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    if (!isScoreDimension(dimension)) {
      throw new Error(`unknown dimension: ${String(dimension)}`);
    }
    // quality 快路径：透传 inspect 快照自带评分 + previousScore 对比基线。
    // performance 条目落在自己的域快照里，必须一并传入，否则 quality 维丢掉 performance 扣分。
    if (dimension === 'quality') {
      const [inspectSnapshot, performanceSnapshot] = await Promise.all([
        readDomainSnapshot(projectPath, 'inspect'),
        readDomainSnapshot(projectPath, 'performance'),
      ]);
      return qualityFastPathScore(inspectSnapshot, performanceSnapshot);
    }
    // 其余 9 维：compose-on-read，与报告中心汇总共用同一输入组装
    const inputs = await assembleHealthInputs(projectPath, {
      listGuardReports,
      readDomainSnapshot,
      readDashboardState,
      buildPipelineExtras,
    });
    const dimensions = buildHealthDimensions({
      guard: inputs.guard,
      inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues, esloc: inputs.esloc } : null,
      projectRoot: projectPath,
      extras: inputs.extras,
    });
    const entry = dimensions.find((d) => d.name === dimension);
    if (!entry) return null;
    return {
      dimension: entry.name,
      score: entry.score,
      issues: entry.issues,
      status: entry.status ?? 'scored',
      generatedAt: inputs.timestamps[dimension],
    };
  } catch (err) {
    console.warn(
      '[engine:getDomainScore] 实时评分读取失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 项目画像（含子模块列表）：供报告页列出模块用于模块级评分卡展示；探测失败时返回 null。
 *
 * 子模块 `path` 在这里统一解析为**绝对路径**：它同时被渲染层当作 `engine:getScore` 的查询键，
 * 也是 `scores.project_id` 的写入键。画像原始值是相对路径（`packages/ui`），直接外传会让
 * 两个 monorepo 的同名子包读同一行记录。渲染层不再做任何路径拼装。
 */
export async function getProfileHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
): Promise<ProjectProfileData | null> {
  try {
    const profilingResult = (await runProfileSyncInWorker(projectPath)).profile;
    cacheProfile(profilingResult, projectPath);
    return {
      type: profilingResult.type,
      modules: (profilingResult.modules ?? []).map((m) => ({
        path: path.resolve(projectPath, m.path),
        type: m.type,
      })),
    };
  } catch (err) {
    console.warn(
      '[engine:getProfile] 画像探测失败:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
