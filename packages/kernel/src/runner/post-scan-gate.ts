import { resolveInstructionScope } from '../sop/_meta/content-interpreter';
import type { SopRule } from '../sop/_meta/sop-types';
import { compareMetric } from './metric-direction';

/**
 * 扫描后门禁（post-scan gate）—— 把「依赖整轮扫描聚合结果」的阈值判定，从规则引擎里摘出来。
 *
 * 为什么必须分阶段（2026-10-29 实测）：
 * 云端有 3 条 active 阈值规则（健康分 / 质量分 / 覆盖率）声明的是**整轮扫描结束后**才存在的数：
 *   · 健康分 / 质量分由 `@zh/scoring` 吃各域 findings 聚合产出；
 *   · 覆盖率要读测试产出的 `coverage-summary.json`。
 * 规则引擎是在扫描**过程中**求值的，此刻聚合分尚未产生。硬在引擎内比较只有两条路：
 * 拿上一轮旧分（用陈旧数据判定当前代码），或判「降级」——后者会让每次体检都固定背 3 条降级，
 * 门禁红灯变成噪音，用户第一件事就是把整套 SOP 关掉。
 *
 * 所以这三条既不是「引擎内检查项」，也不该被删除 —— 它们自述就是 **L2/L3 门禁**。
 * 正解是给它们一个属于自己的阶段：扫描完成 → 拿到聚合数据 → 判阈值 → 阻断与否。
 *
 * 本模块只做判定（纯函数），取数由调用方注入：
 *   · CLI 侧只能拿到覆盖率（无聚合评分）⇒ 健康分/质量分落 undetermined 并写明原因；
 *   · 桌面端在评分阶段调用，三项都可得。
 * **拿不到数一律 `undetermined` + 具体原因，绝不按 passed 处理。**
 */

/** 门禁指标口径 —— 决定「拿什么数来比」 */
export type GateMetric = 'health-score' | 'quality-score' | 'coverage';

/**
 * 后置门禁显式登记表：规则 id → 指标口径。
 *
 * 为什么不按指标名/unit 猜：解释器把单数 `threshold: 70` 折叠成键名 `value`，
 * 指标名里不含任何语义，健康分/质量分/覆盖率三条**共用 `value`**。
 * 按名字取数会让三条读同一个数 —— 那就是又一次「显示通过、实际比错数」。
 * 未登记的一律判 undetermined，不猜。
 */
export const POST_SCAN_GATE_BINDINGS: Readonly<Record<string, GateMetric>> = {
  'guard.block.official.health-score': 'health-score',
  'guard.block.official.test-coverage': 'coverage',
  'inspect.score.official.quality-score': 'quality-score',
};

/**
 * 引擎内可直接测得的指标（复杂度五项，由 `@zh/pipeline` 的 rule-metrics 取数）。
 * 用于准入校验：一条 active 阈值规则既不在这里、也没登记为后置门禁 ⇒ 它永远拿不到数。
 */
export const ENGINE_MEASURABLE_METRICS: readonly string[] = [
  'cyclomaticComplexity',
  'functionLength',
  'fileLength',
  'nestingDepth',
  'parameterCount',
];

/** 规则内容里显式声明执行阶段的字段（新增规则首选写法，优先级高于 id 登记表） */
export const POST_SCAN_STAGE = 'post-scan';

/** 单条规则的门禁声明（纯读取，不做任何判定） */
export interface GateDeclaration {
  /** 是否属于扫描后门禁（应当从引擎执行清单里剔除） */
  readonly isGate: boolean;
  /** 指标口径；已声明为门禁但未登记口径时为 undefined（判定阶段落 undetermined） */
  readonly metric?: GateMetric;
  /** 规则声明的指标键（单数 threshold ⇒ `value`），供准入校验使用 */
  readonly declaredMetrics: readonly string[];
  readonly threshold?: number;
  readonly unit?: string;
}

/** 读取门禁声明。单数 `threshold` 与复数 `thresholds` 都认，与解释器同一口径。 */
export function readGateDeclaration(rule: SopRule): GateDeclaration {
  const raw = (rule.content ?? {}) as Record<string, unknown>;
  const scope = resolveInstructionScope(raw);
  const metric = POST_SCAN_GATE_BINDINGS[rule.id];
  const stage = typeof scope.executionStage === 'string' ? scope.executionStage : undefined;
  const thresholds = scope.thresholds;
  const declaredMetrics =
    typeof thresholds === 'object' && thresholds !== null && !Array.isArray(thresholds)
      ? Object.keys(thresholds as Record<string, unknown>)
      : typeof scope.threshold === 'number'
        ? ['value']
        : [];
  const threshold = typeof scope.threshold === 'number' ? scope.threshold : undefined;
  const unit = typeof scope.unit === 'string' ? scope.unit : undefined;
  return {
    isGate: metric !== undefined || stage === POST_SCAN_STAGE,
    ...(metric !== undefined ? { metric } : {}),
    declaredMetrics,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
}

/** 从规则集合中挑出后置门禁 */
export function selectPostScanGates(rules: readonly SopRule[]): SopRule[] {
  return rules.filter((rule) => readGateDeclaration(rule).isGate);
}

/** 调用方给门禁的实测值：有值给 actual，取不到给原因（两者都不是空对象） */
export type GateValue = { readonly actual: number } | { readonly unavailableReason: string };

export type GateStatus = 'passed' | 'failed' | 'undetermined';

export interface GateItem {
  readonly ruleId: string;
  readonly metric?: GateMetric;
  readonly status: GateStatus;
  readonly threshold?: number;
  readonly actual?: number;
  readonly unit?: string;
  readonly message: string;
}

export interface PostScanGateReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** 没有判定（缺数据 / 缺口径 / 缺阈值）——既不算通过也不算失败 */
  readonly undetermined: number;
  /** 严格通过：全部判定完成且无一越界。undetermined 存在时为 false */
  readonly ok: boolean;
  /** 是否全部完成判定（undetermined === 0） */
  readonly complete: boolean;
  readonly items: readonly GateItem[];
}

const METRIC_LABEL: Record<GateMetric, string> = {
  'health-score': '健康分',
  'quality-score': '质量分',
  coverage: '测试覆盖率',
};

function metricLabel(metric: GateMetric | undefined): string {
  return metric ? METRIC_LABEL[metric] : '阈值指标';
}

function unitSuffix(unit: string | undefined): string {
  return unit ? ` ${unit}` : '';
}

/**
 * 判定全部门禁规则。
 *
 * @param rules   候选规则（内部按 `readGateDeclaration` 过滤，非门禁规则不会出现在报告里）
 * @param resolve 每规则取数；取不到必须返回 unavailableReason，不要伪造数字
 */
export function evaluatePostScanGates(
  rules: readonly SopRule[],
  resolve: (rule: SopRule) => GateValue,
): PostScanGateReport {
  const items = selectPostScanGates(rules).map((rule) => judgeGate(rule, resolve));
  const passed = items.filter((item) => item.status === 'passed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const undetermined = items.filter((item) => item.status === 'undetermined').length;
  return {
    total: items.length,
    passed,
    failed,
    undetermined,
    ok: failed === 0 && undetermined === 0,
    complete: undetermined === 0,
    items,
  };
}

function judgeGate(rule: SopRule, resolve: (rule: SopRule) => GateValue): GateItem {
  const decl = readGateDeclaration(rule);
  const base = { ruleId: rule.id, ...(decl.metric ? { metric: decl.metric } : {}) };
  if (decl.threshold === undefined) {
    return {
      ...base,
      status: 'undetermined',
      message: '后置门禁未声明可比较的 threshold，无法判定（该规则当前不产生任何门禁结论）',
    };
  }
  if (decl.metric === undefined) {
    return {
      ...base,
      status: 'undetermined',
      threshold: decl.threshold,
      message:
        '已声明为后置门禁，但未登记指标口径（见 kernel/src/runner/post-scan-gate.ts 的 ' +
        'POST_SCAN_GATE_BINDINGS），无法确定拿哪个数来比',
    };
  }

  const value = resolve(rule);
  if ('unavailableReason' in value) {
    return {
      ...base,
      status: 'undetermined',
      threshold: decl.threshold,
      ...(decl.unit ? { unit: decl.unit } : {}),
      message: `门禁未判定：${value.unavailableReason}`,
    };
  }

  const verdict = compareMetric(value.actual, decl.threshold, decl.unit);
  const suffix = unitSuffix(decl.unit);
  const head = `${metricLabel(decl.metric)}=${value.actual}${suffix}，阈值 ${decl.threshold}${suffix}`;
  return {
    ...base,
    status: verdict === 'breached' ? 'failed' : 'passed',
    threshold: decl.threshold,
    actual: value.actual,
    ...(decl.unit ? { unit: decl.unit } : {}),
    message: verdict === 'breached' ? `${head} — 未达标` : `${head} — 达标`,
  };
}

/** 终端可读的逐条文本（CLI / 日志复用，避免各处自己拼） */
export function formatGateItems(report: PostScanGateReport): string[] {
  return report.items.map((item) => {
    const mark = item.status === 'passed' ? '✓' : item.status === 'failed' ? '✗' : '–';
    return `${mark} ${item.ruleId}: ${item.message}`;
  });
}
