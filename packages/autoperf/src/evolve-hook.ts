/**
 * AutoPerf → Evolve 经验库回写钩子
 *
 * 性能自动化体系统一的「验证回写层」：将 AutoPerf 性能预算扫描结果回写进 evolve
 * 经验库（source='auto'，自动化发现而非用户反馈），使性能问题像代码缺陷一样被
 * 记录、追溯、并驱动 evolve 的规则权重自校准。
 *
 * 设计要点：
 * - 惰性初始化 evolve 引擎（避免静态 import 造成内核未构建时加载失败）。
 * - fire-and-forget：回写失败绝不阻断扫描结果，无条件静默降级。
 * - 严重级映射：severity=error → true-positive（确证问题，置信度 0.9）；
 *   severity=warning → best-practice（边界情况值得追踪，置信度 0.6）。
 */
import type { AutoPerfReport } from './types';

// 惰性单例（与 desktop ipc-context.getEvolve 模式一致），避免 evolve 未构建时的加载耦合。
// evolve 的 EvolveEngine.recordExperience / autoAdjustWeights 均为同步方法。
type EvolveLike = { recordExperience(entry: unknown): void; autoAdjustWeights(): void };

let evolvePromise: Promise<EvolveLike> | null = null;

async function getEvolve(): Promise<EvolveLike> {
  if (!evolvePromise) {
    evolvePromise = import('@zh/evolve').then(({ EvolveEngine }) => new EvolveEngine());
  }
  return evolvePromise;
}

/**
 * 将 AutoPerf 扫描结果回写到 evolve 经验库。
 * - severity=error → type 'true-positive'（真实性能问题，置信度 0.9）
 * - severity=warning → type 'best-practice'（边界情况，置信度 0.6）
 * - source 固定为 'auto'（自动化发现，非用户反馈）
 * - 有 Issue 时触发 autoAdjustWeights（规则权重自校准）
 *
 * @param projectId 项目路径（作为 projectId）
 * @param report AutoPerf 扫描报告（probes + issues）
 */
export async function recordPerfExperience(
  projectId: string,
  report: AutoPerfReport,
): Promise<void> {
  if (report.issues.length === 0) return;

  const evolve = await getEvolve();
  for (const issue of report.issues) {
    const isError = issue.severity === 'error';
    evolve.recordExperience({
      projectId,
      ruleId: issue.ruleId,
      type: isError ? 'true-positive' : 'best-practice',
      pattern: issue.fingerprint ?? issue.ruleId,
      message: issue.message,
      feedback: `[AutoPerf 自动检测] ${issue.message}`,
      source: 'auto',
      confidence: isError ? 0.9 : 0.6,
      verified: false,
    });
  }
  evolve.autoAdjustWeights();
}
