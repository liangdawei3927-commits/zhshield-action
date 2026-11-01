/**
 * 评分 / 画像只读处理器（ipc/engines-scoring-read.ts）
 *
 * 评分读取、分类页实时评分、报告中心总览、治理域快照与项目画像查询 —— 全部只读、不写库。
 * 由 engines.ts 引用；输入组装复用 engines-scoring.ts 的 helper（不得 import engines.ts）。
 */

import path from 'node:path';
import { t } from '@zh/i18n';
import { buildHealthDimensions, computeOverallSnapshot, computeRedLine } from '@zh/scoring';
import { listGuardReports } from '@zh/guard';
import type { PostScanGateReport } from '@zh/kernel';
import { readDomainSnapshot } from '../zh-diagnostics';
import type { DiagnosticSource, DiagnosticsReport } from '../zh-diagnostics-types';
import { readDashboardState } from './dashboard-state';
import { getScoring } from '../ipc-context';
import { runProfileSyncInWorker } from '../profile-host';
import { toHealthScoreData, type HealthScoreData } from './report-format';
import { evaluateProjectGates } from './project-gates';
import type { DomainScoreData, ProjectProfileData } from '../../src/types/electron';
import {
  assembleHealthInputs,
  isScoreDimension,
  qualityFastPathScore,
  type ScoreDimension,
} from '../report-summary';
import {
  buildPipelineExtras,
  cacheProfile,
  collectScoringInputs,
  probeProjectProfile,
} from './engines-scoring';

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
