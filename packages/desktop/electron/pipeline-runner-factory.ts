/**
 * PipelineRunner 装配工厂 — 各入口共用（T13 口径统一）
 *
 * 「同一个域，页面点与流水线跑，必须是同一套规则集」。此前 `runGuardJob`
 * （门禁页）自建 GuardEngine 且**未接 SOP 引擎** —— 缺 `useSopEngine` 连线，
 * 于是 `GuardEngine.run()` 落到 runTraditional 分支读 checks.json（4 项），
 * 而流水线的门禁阶段走 SOP 规则。同一个「门禁」两套规则集，条目数与结论都不一致。
 *
 * 现在把「建 runner + 载入内置规则 + 合并云同步规则」收敛到本模块的
 * `createLoadedRunner`：任何入口要跑某个治理域，都必须经由此函数拿到 runner，
 * 从机制上排除再次分叉。
 *
 * 之所以要连 `ZH_SOP_CACHE_DIR` 一起载入：只载内置模板（44 条）而漏掉云同步规则，
 * 等价于又造出「内置口径 vs 云端口径」的第二处分叉。
 */
import type { PipelineRunner } from '@zh/pipeline';

export interface LoadedRunner {
  runner: PipelineRunner;
  /** 从云同步缓存合并的规则条数；0 = 仅内置模板（云端缓存不可用属正常降级） */
  syncedRules: number;
}

/** 建 PipelineRunner 并完成规则装载（内置 + 云同步），供所有入口复用 */
export async function createLoadedRunner(projectPath: string): Promise<LoadedRunner> {
  const { PipelineRunner: Runner } = await import('@zh/pipeline');
  const runner = new Runner(projectPath);
  await runner.loadSopRules();

  let syncedRules = 0;
  const cacheDir = process.env.ZH_SOP_CACHE_DIR;
  if (cacheDir) {
    syncedRules = await runner.loadSopRulesFromCache(cacheDir);
  }
  return { runner, syncedRules };
}
