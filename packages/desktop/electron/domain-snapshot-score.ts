/**
 * 单域快照落盘时的当场出分（domain-snapshot-score.ts）
 *
 * 解决的问题：buildDomainSnapshot 仅对 inspect 域 enrich dimensionScore，
 * security/deps/garbage/performance 四域快照 score=null → 域历史表「分数」列恒「—」。
 *
 * 口径纪律（单一来源）：本文件**不新开算分路径**，与分类页实时评分
 * （getDomainScoreHandler compose-on-read）、报告中心汇总共用同一个
 * `buildHealthDimensions`；这里只做「该域输入的最小子集组装」：
 * - security 维 = 该域快照条目（category==='security'，含密钥条目）+ dashboard-state
 *   同源的 activeSecrets 绝对扣分 —— 与 assembleHealthInputs 的合并口径一致；
 * - dependencies 维 = 该域快照条目（category==='dependency'）+ deps 漏洞计数绝对扣分；
 * - performance / garbage 维 = 摘要数据计权（与 dashboard-state patch 同源同形），
 *   这两维不吃条目（性能/垃圾类条目归 quality 维扣分，见 DIMENSION_CATEGORIES）；
 * - techdebt 维 = 100 − debtIndex（与 dashboard-state.techdebt 同源同形），
 *   同样不吃条目 —— 债务动作条目归 inspect 快照的 quality 维，techdebt 维自己
 *   没有 category 映射（DIMENSION_CATEGORIES.techdebt 为空数组）。
 *
 * 零 Electron 依赖：纯计算，可直接单测。
 */
import {
  buildHealthDimensions,
  SCORE_VERSION,
  type DepsDataLike,
  type PerformanceDataLike,
  type GarbageDataLike,
  type TechDebtDataLike,
} from '@zh/scoring';
import type { DiagnosticEntry, DomainDimensionScore } from './zh-diagnostics-types';

/**
 * 五个此前不出分的域（quality 已由 enrichInspectSnapshot 覆盖；gate 语义不同暂不出分）。
 *
 * techdebt 在此列（2026-10-28 补）：它此前落盘时压根没传 dimensionScore，
 * 分类页历史表「分数」列恒「—」、较上次恒「无基线」——不是该域不出分，是漏了接线。
 */
export type SnapshotScoreDimension =
  | 'security'
  | 'dependencies'
  | 'performance'
  | 'garbage'
  | 'techdebt';

/** 各域评分输入（判别联合：字段名自解释，防 position 传参传反） */
export type DomainSnapshotScoreInput =
  | {
      dimension: 'security';
      /** security 域快照的合并条目（漏洞 + 密钥），与将要落盘的快照条目同源 */
      entries: readonly DiagnosticEntry[];
      /** 未处理密钥数（dashboard-state.secrets.activeCount；secrets 从未扫描 → null） */
      activeSecrets: number | null;
    }
  | {
      dimension: 'dependencies';
      /** deps 域快照条目（normalizeDepsSource 产物） */
      entries: readonly DiagnosticEntry[];
      /** 漏洞计数 + 可升级数（depsDashboardPatch 同形） */
      deps: DepsDataLike | null;
    }
  | { dimension: 'performance'; performance: PerformanceDataLike }
  | { dimension: 'garbage'; garbage: GarbageDataLike }
  | {
      dimension: 'techdebt';
      /**
       * 债务指数 + 动作数（updateTechDebtDashboard 写进 dashboard-state 的同形数据）。
       * null = 本次没算出债务指数（如无 inspect 快照、未真跑）→ not-run，不冒充 100 分。
       */
      techdebt: TechDebtDataLike | null;
    };

/**
 * 计算某域快照的 dimensionScore。
 *
 * 返回 undefined = 该维按规范口径 not-run（如 security 无条目且无 secrets 数据），
 * 调用方不附加评分（快照无 dimensionScore → 历史记录 score=null → UI 显示「—」），
 * 绝不把 not-run 伪装成满分（spec C）。
 */
export function computeDomainSnapshotScore(
  input: DomainSnapshotScoreInput,
): DomainDimensionScore | undefined {
  const extras = buildExtras(input);
  // security/dependencies 维吃该域条目（scoreInspectBased 按 category 过滤）；
  // performance/garbage/techdebt 维不吃条目 → inspect 传 null（quality 维 not-run 与本域无关）。
  const inspect =
    input.dimension === 'security' || input.dimension === 'dependencies'
      ? { issues: toScoreIssues(input.entries), esloc: 0 }
      : null;
  const dimensions = buildHealthDimensions({ guard: null, inspect, extras });
  const entry = dimensions.find((d) => d.name === input.dimension);
  if (!entry || entry.status === 'not-run') return undefined;
  return {
    dimension: entry.name as SnapshotScoreDimension,
    score: entry.score,
    issues: entry.issues,
    status: 'scored',
    version: SCORE_VERSION,
  };
}

function buildExtras(input: DomainSnapshotScoreInput): Record<string, unknown> {
  switch (input.dimension) {
    case 'security':
      // activeSecrets 为 null = secrets 从未扫描 → 传 null（不冒充 0 个密钥）
      return {
        secrets: input.activeSecrets === null ? null : { activeCount: input.activeSecrets },
      };
    case 'dependencies':
      return { deps: input.deps };
    case 'performance':
      return { performance: input.performance };
    case 'garbage':
      return { garbage: input.garbage };
    case 'techdebt':
      return { techdebt: input.techdebt };
  }
}

/** DiagnosticEntry → 评分入参的最小投影（severity/category/ruleId 三字段足矣） */
function toScoreIssues(
  entries: readonly DiagnosticEntry[],
): Array<{ severity: DiagnosticEntry['severity']; category: string; ruleId: string }> {
  return entries.map((e) => ({ severity: e.severity, category: e.category, ruleId: e.ruleId }));
}
