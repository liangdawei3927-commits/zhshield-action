/**
 * 评分 / 画像 / 报告中心处理器（ipc/engines-scoring.ts）
 *
 * 健康评分写分点、分类页实时评分、报告中心只读汇总与项目画像缓存。
 * 由 engines.ts 引用，依赖方向单向：engines.ts → 本文件（本文件不得 import engines.ts）。
 */

import path from 'node:path';
import { t } from '@zh/i18n';
import { buildHealthDimensions, computeOverallSnapshot, computeRedLine, scoreProjectByModules } from '@zh/scoring';
import type { ConvertedGuardResult, ConvertedInspectIssue } from '@zh/scoring';
import { listGuardReports } from '@zh/guard';
import type { GuardReport } from '@zh/guard';
import type { PipelineReport } from '@zh/pipeline';
import type { PostScanGateReport } from '@zh/kernel';
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
import { evaluateProjectGates } from './project-gates';
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
 * 汇总评分输入，并判定「是否至少有一个域出过结果」。
 *
 * 「写分」与「总览」两条入口此前各自复制同一段输入组装 + hasResults 判定。
 * 复制品一旦分叉就会重现 2026-10-24 那两个分的故障（同一时刻写出两个总分），
 * 故收敛为唯一实现：两条入口结构上不可能既不同源又都正确。
 */
async function collectScoringInputs(projectPath: string) {
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
 * 报告中心「评分总览」的实时视图（engine:getHealthOverview）——**只读，不落库**。
 *
 * 为什么必须单独开这一条（2026-10-24 P0，用户实测「卡片 100 分、点进去 92.9」）：
 * 卡片行原先读 `scores` 表里最近一条**历史汇总记录**（生成那一刻的时点快照），
 * 而分类页走 `getDomainScore` **实时重算**。两条链不同源 ⇒ 中间任何一次扫描都会让
 * 它们分叉，对不上是必然的、不是偶发。
 *
 * 两条同源保证：
 * 1. 与分类页共用 `assembleHealthInputs` + `buildHealthDimensions`（同一函数、同一输入形状）；
 * 2. **一次组装取满十维** —— 若改成调十次 `getDomainScore`，十张卡会跨越两次扫描、
 *    各自属于不同时刻，等于换个姿势继续对不上。
 *
 * 不落库：总分走 `computeOverallSnapshot`（与 `ScoringEngine.calculate` 同一套
 * 加权/封顶/分级规则，但不写 `scores` 表）。否则「打开报告中心」本身就变成一次评估，
 * 历史曲线会被浏览行为污染。
 */
export interface HealthOverviewDimension {
  name: ScoreDimension;
  score: number;
  issues: number;
  weight: number;
  status: 'scored' | 'not-run';
  /** 该维数据时间（域快照 / 门禁报告落盘时间）；该域从未跑过 → null */
  generatedAt: string | null;
}

/** 健康总览：读磁盘最新快照实时计算（不落库，浏览报告中心不会污染历史曲线） */
export interface HealthOverviewData {
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: HealthOverviewDimension[];
  redLine?: { capped: boolean; cap: number; reasons: Array<{ kind: string; count: number }> };
  /** 本次读取时刻（不是域数据时间；各维时间见 dimensions[].generatedAt） */
  readAt: string;
  /**
   * 后置门禁结论（健康分 / 覆盖率）。
   *
   * 与总分同一次读取产生：门禁要拿的「健康分」就是这里的 `overall`，
   * 分成两次 IPC 取会出现「卡片 92 分、门禁按 88 分判」的错位。
   * 没有门禁规则时 `total === 0`，`ok` 为 true 但含义是「无门禁」而非「全达标」——
   * 渲染层必须区分这两者（见 report-gates 组件的空态文案）。
   */
  gates?: PostScanGateReport;
}

export async function getHealthOverviewHandler(
  _event: Electron.IpcMainInvokeEvent,
  projectPath: string,
): Promise<HealthOverviewData | null> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error(t('electron.invalidProjectPath'));
    }
    const { inputs, hasResults } = await collectScoringInputs(projectPath);
    // 一穷二白的新项目返回 null（由 UI 提示先跑检查），绝不返回一条 0 分总览
    if (!hasResults) return null;

    const profilingResult = await probeProjectProfile(projectPath);
    const dimensions = buildHealthDimensions({
      guard: inputs.guard,
      inspect: inputs.inspectIssues ? { issues: inputs.inspectIssues, esloc: inputs.esloc } : null,
      projectRoot: projectPath,
      profile: profilingResult,
      extras: inputs.extras,
    });
    const snapshot = computeOverallSnapshot(dimensions, computeRedLine(inputs.extras));
    return {
      overall: snapshot.overall,
      grade: snapshot.grade,
      dimensions: dimensions.map((d) => ({
        name: d.name as ScoreDimension,
        score: d.score,
        issues: d.issues,
        weight: d.weight,
        status: d.status === 'not-run' ? 'not-run' : 'scored',
        generatedAt: inputs.timestamps[d.name as ScoreDimension] ?? null,
      })),
      ...(snapshot.redLine ? { redLine: snapshot.redLine } : {}),
      readAt: new Date().toISOString(),
      // 门禁判定与总分同源：拿的就是上面这个 overall，不另算一个分
      gates: evaluateProjectGates(projectPath, snapshot.overall),
    };
  } catch (err) {
    console.warn(
      '[engine:getHealthOverview] 实时总览读取失败:',
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
