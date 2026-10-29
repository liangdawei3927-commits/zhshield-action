import type { PipelineRunner } from '@zh/pipeline';
import { formatGateItems } from '@zh/pipeline';

import { STALE_CACHE_DAYS, formatAge } from './sop-source';
import type { CacheFreshness, SopCacheResolution } from './sop-source';
import { readBooleanEnv } from './env-flag';

/**
 * CLI 的「规则从哪来」与「门禁到底判了没有」两个出口。
 *
 * 从 index.ts 抽出（2026-10-29）：入口文件此前把装载、路由、门禁输出混在一起，
 * 而这两段话术恰好是本轮最容易出错的语义 —— 它们决定用户看到的绿灯是真的还是空的。
 *
 * 贯穿本模块的一条断言：**没有结论 ≠ 通过。**
 * 此前 `report.total === 0` 直接 return，于是「一条门禁规则都没加载」与
 * 「门禁全部达标」在终端上完全长得一样 —— 都是安静退出 0。
 *
 * 另有一条接缝教训（同日实测，形态⑧）：门禁判定曾写在 `index.ts` 命令 return 之后，
 * 而全部命令都以 `process.exit()` 终止进程 ⇒ 那段代码**真实进程里永远不可达**，
 * 只在 mock 掉 process.exit 的单测里「跑通过」。故本模块的输出必须由
 * `commands.ts` 的统一出口 `finalizeScan` 在 exit **之前**调用。
 */

/** 本次进程装载到的规则全貌 */
export interface SopSourceSummary {
  /** 内置模板加载器计数（`loadSopRules()` 返回值） */
  readonly bundled: number;
  /** 云端同步规则加载器计数（`loadSopRulesFromCache()` 返回值）；0 = 未加载 */
  readonly synced: number;
  /** registry 真值（去重合并后）——条数只认这个 */
  readonly total: number;
  readonly active: number;
  readonly cache: SopCacheResolution;
  readonly freshness: CacheFreshness;
}

/**
 * 本次进程的规则装载上下文。
 *
 * 为什么用模块级状态而不是层层传参：CLI 是**单命令单进程**，一次运行只有一份装载结果；
 * 为它给四个命令函数各加一个参数，只会让调用方多一个可以传错的位置。
 * 未注入时（单测直接驱动 commands）按下「云端规则未加载」处理 —— 保守方向。
 */
let currentSummary: SopSourceSummary | undefined;

/** 注入装载上下文（入口 `loadSopRulesWithCloud` 之后调用一次） */
export function setSopSourceSummary(summary: SopSourceSummary): void {
  currentSummary = summary;
}

/** 清空装载上下文（用例隔离用） */
export function clearSopSourceSummary(): void {
  currentSummary = undefined;
}

function requireSummary(): SopSourceSummary {
  return (
    currentSummary ?? {
      bundled: 0,
      synced: 0,
      total: 0,
      active: 0,
      cache: { origin: '未注入', reason: '未注入规则装载上下文（入口未调用 setSopSourceSummary）' },
      freshness: { fileCount: 0 },
    }
  );
}

/** 真空门禁开关：CI / pre-commit 用它把「门禁结论缺失」升格为失败 */
export const REQUIRE_SOP_ENV = 'ZH_GATE_REQUIRE_SOP';

/** 是否要求本次必须有门禁结论（显式开关，默认宽松 —— 否则没装桌面端的 CI 会永久红） */
export function isRequireSop(env: NodeJS.ProcessEnv): boolean {
  return readBooleanEnv(env, REQUIRE_SOP_ENV);
}

function unavailableReason(summary: SopSourceSummary): string {
  if (summary.cache.reason) return summary.cache.reason;
  // 目录可用却 0 条：缓存目录存在但里面没有规则文件（同步从未落盘 / 被清空）
  if (summary.cache.dir) return `${summary.cache.dir}/modules 中没有可用的规则文件`;
  return '原因未知';
}

/** 规则源横幅（始终打印；口径与条数以 registry 为准） */
export function formatSopSourceBanner(summary: SopSourceSummary): string[] {
  const lines = [`[CLI] SOP 规则注册 ${summary.total} 条（活跃 ${summary.active}）`];
  lines.push(`        · 内置模板 ${summary.bundled} 条`);

  if (summary.synced > 0) {
    lines.push(`        · 云端同步 ${summary.synced} 条 — ${describeCache(summary)}`);
    if (summary.bundled + summary.synced !== summary.total) {
      lines.push('        （两源按 id 合并，重复项以云端为准，故合计不等于相加）');
    }
    lines.push(...staleWarning(summary.freshness));
  } else {
    lines.push(`        · 云端同步 0 条 — 未加载：${unavailableReason(summary)}`);
  }
  return lines;
}

function describeCache(summary: SopSourceSummary): string {
  const { cache, freshness } = summary;
  const parts = [cache.origin];
  if (freshness.updatedAt) {
    parts.push(`缓存于 ${formatCacheTime(freshness.updatedAt)}`);
    if (freshness.ageMs !== undefined) parts.push(formatAge(freshness.ageMs));
  }
  // 两份候选缓存同时存在时，`reason` 记的是「为什么取了这一份」——必须打出来，
  // 否则「同步过了却还在用旧规则」只能靠猜（见 sop-source.ts 的 pickFreshestCache）。
  if (cache.reason) parts.push(cache.reason);
  return parts.join('，');
}

/** 缓存时间用本地时可读格式，别打 ISO（终端里没人想看 T/Z） */
function formatCacheTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 陈旧规则必须提示：云大脑按日同步，用一周前的阈值判今天的代码属"合法失真" */
function staleWarning(freshness: CacheFreshness): string[] {
  if (freshness.ageMs === undefined) return [];
  const days = freshness.ageMs / 86_400_000;
  if (days < STALE_CACHE_DAYS) return [];
  return [
    `        ⚠ 云端规则已 ${Math.floor(days)} 天未更新（设计为每日同步），门禁阈值可能已过期`,
  ];
}

/** 门禁结论的最终去向 */
export interface GateReportOutcome {
  /** 建议的退出码（undefined = 不改动既有退出码） */
  readonly exitCode?: number;
}

/**
 * 打印扫描后门禁结论。
 *
 * 四态，缺一不可：
 *   ① 有门禁且全达标      → ✓ 全部达标
 *   ② 有门禁且有未达标    → 阻断（exit 1）
 *   ③ 有门禁但存在未判定  → 明示「不算通过」，不阻断（缺数据不等于代码有问题）
 *   ④ **一条门禁规则都没有** → 必须区分成因，绝不沉默：
 *        · 云端规则已加载 ⇒ 这次规则集里确实没有门禁规则（合法，提示即可）
 *        · 云端规则未加载 ⇒ 门禁结论不可用（`guard.block.official.*` 只在云端下发）
 */
export function reportPostScanGates(
  runner: PipelineRunner,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): GateReportOutcome {
  const summary = requireSummary();
  const report = runner.evaluatePostScanGates();

  if (report.total === 0) {
    return reportNoGateRules(summary, env, log);
  }

  log('\n[门禁] 扫描后判定（健康分 / 覆盖率）');
  for (const line of formatGateItems(report)) log(`  ${line}`);

  if (report.failed > 0) {
    log(`[门禁] ${report.failed} 项未达标 — 阻断`);
    return { exitCode: 1 };
  }
  if (report.undetermined > 0) {
    // 未判定**不**升格为失败：CLI 不做聚合评分，`health-score` 这类指标在 CLI 侧
    // 永远取不到数，那是设计如此、不是环境缺陷。把它算红会让 require 模式恒红，
    // 用户第一件事就是把整套门禁关掉 —— 护栏变成摆设。
    log(`[门禁] ${report.undetermined} 项未判定（缺数据源，不算通过）`);
    return {};
  }
  log(`[门禁] 全部 ${report.total} 项达标`);
  return {};
}

function reportNoGateRules(
  summary: SopSourceSummary,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): GateReportOutcome {
  if (summary.synced > 0) {
    log('');
    log(
      `[门禁] 本次规则集（内置 ${summary.bundled} + 云端 ${summary.synced}）不含扫描后门禁规则 —— ` +
        '门禁阶段无结论，这不代表通过',
    );
    return {};
  }

  log('');
  log(`[门禁] 未判定 — 本次未加载云端规则：${unavailableReason(summary)}`);
  log(
    '[门禁] 云端门禁规则（guard.block.official.health-score / test-coverage）只在云端下发，' +
      '内置模板里没有 ⇒ 本次没有任何门禁结论。empty ≠ passed',
  );
  if (isRequireSop(env)) {
    log(`[门禁] ${REQUIRE_SOP_ENV} 已开启 ⇒ 判为环境不完整，退出码 2`);
    return { exitCode: 2 };
  }
  log(`[门禁] 需要真空门禁请设 ${REQUIRE_SOP_ENV}=1（此项将判为环境不完整并退出 2）`);
  return {};
}

/**
 * 扫描类命令的统一出口：**先判门禁，再退出**。
 *
 * 退出码优先级：违规阻断（1）> 既有 exitCode（降级护栏 2）> 门禁结论。
 * 降级护栏的 2 不能被子门禁的 1 覆盖 —— 环境不完整比单条阈值更严重。
 */
export function finalizeScan(
  runner: PipelineRunner,
  opts: { readonly sop: boolean },
  blocked: boolean,
  exit: (code?: number | string) => never = (code) => process.exit(code),
  log: (line: string) => void = (line) => console.error(line),
): never {
  const gate: GateReportOutcome = opts.sop ? reportPostScanGates(runner, log) : {};
  if (blocked) return exit(1);
  if (process.exitCode) return exit(process.exitCode);
  return exit(gate.exitCode);
}
