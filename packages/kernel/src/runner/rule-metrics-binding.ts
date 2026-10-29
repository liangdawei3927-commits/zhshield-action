import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { RuleMetricsProvider } from './evaluator-host';

/**
 * 把「这条规则要的实测值」解析进上下文副本（threshold 指令专用）。
 *
 * 从 SopRuleEngine 类体抽出（2026-10-29）：这是纯装配逻辑，不含引擎状态，
 * 留在类里只为让类体超限。三种结果必须可区分：
 * - 无 provider ⇒ 原样返回，evalThreshold 按「缺度量」降级；
 * - provider 抛错 / 声明口径不可满足 ⇒ 带 `metricsUnavailable` 返回，降级文案点明原因；
 * - provider 正常 ⇒ 合并进 extra.metrics。
 *
 * **绝不原地改 context.extra**：context 被 evaluateAll 的有界并行池内所有 worker 共享，
 * 就地写会让先算完的规则把指标留给后一条（已有用例锁死）。
 *
 * 失败一律不判 error：度量源故障不该让整条规则从报告里消失，但也不能伪装成通过。
 */
export async function applyRuleMetrics(
  provider: RuleMetricsProvider | undefined,
  rule: SopRule,
  context: RuleContext,
  onError: (message: string) => void,
): Promise<RuleContext> {
  if (!provider) return context;
  try {
    const result = await provider(rule, context);
    return {
      ...context,
      extra: {
        ...context.extra,
        metrics: result.metrics,
        metricsUnavailable: result.unavailableReason,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError(`规则 ${rule.id} 度量数据源解析失败: ${message}`);
    return {
      ...context,
      extra: { ...context.extra, metricsUnavailable: `度量数据源异常: ${message}` },
    };
  }
}
