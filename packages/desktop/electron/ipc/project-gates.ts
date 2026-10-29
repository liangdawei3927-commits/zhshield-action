/**
 * 项目门禁判定（桌面端评分阶段）
 *
 * 为什么放在评分阶段而不是扫描阶段：健康分/覆盖率都是**整轮扫描结束后**才存在的
 * 聚合值，规则引擎在扫描过程中求值必然拿不到（见 `@zh/kernel` 的 post-scan-gate 注释）。
 * 桌面端在这里已经是「各域最新结果汇总完毕、总分算完」的时刻，正好是门禁该判的时候。
 *
 * 规则来源用全局 `sopRegistry`（云同步落地的那一份）而不是临时建一个 PipelineRunner：
 * ① 建 runner 要重新装载全部规则，成本远高于判两条门禁；
 * ② 面板上的规则清单读的也是这份注册表 —— 用同一份才不会出现
 *    「面板说有这条规则、门禁却不判它」。
 *
 * ⚠️ `git merge-base` / `git diff` 是同步子进程调用，会占用主进程。只有规则里真的
 * 声明了 `scope: diff` 的覆盖率门禁才会走到 git（其它指标直接取数），
 * 且单个 git 调用有 15s 上限；若将来 diff 规模导致卡顿，再把本模块挪进 worker。
 */
import { evaluatePostScanGates } from '@zh/kernel';
import type { PostScanGateReport } from '@zh/kernel';
import { createGateMetricResolver } from '@zh/pipeline';

import { sopRegistry } from '../ipc-context';

/**
 * 判定当前项目的全部后置门禁。
 *
 * @param projectPath 项目根（读覆盖率报告、求 git 基线）
 * @param healthScore 本轮汇总出的健康总分（0–100）；undefined 时健康分门禁落「未判定」
 */
export function evaluateProjectGates(
  projectPath: string,
  healthScore: number | undefined,
): PostScanGateReport {
  const rules = sopRegistry.getActive();
  return evaluatePostScanGates(
    rules,
    createGateMetricResolver(projectPath, {
      ...(typeof healthScore === 'number' ? { healthScore } : {}),
    }),
  );
}
