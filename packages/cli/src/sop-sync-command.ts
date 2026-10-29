import type { SopCacheEnv } from './sop-source';
import { resolveSopWriteDir } from './sop-source';
import type { SopRemoteSettings } from './sop-remote-config';
import { ALLOW_UNSIGNED_ENV } from './sop-remote-config';
import { readSyncMeta, syncRulesFromCloud } from './sop-remote-sync';
import type { SopSyncResult } from './sop-remote-sync';

/**
 * `zhshield sop sync` —— 把云端规则拉到本地，供无桌面端的 CI / pre-commit 使用。
 *
 * 为什么单独一条命令而不是让 `--sop` 顺手同步：扫描是**判定**动作，同步是**取数**动作。
 * 混在一起会有两个后果 —— ① 每次扫描都要等网络，pre-commit 从 60s 变成不确定时长；
 * ② 网络抖动直接改变门禁结论（同一份代码，昨天红今天绿），这种不确定性会让人
 * 第一件事就是把门禁关掉。分开之后，CI 里的失败点很明确：同步步骤红 = 取数失败。
 *
 * 输出刻意分成「取数参数 → 结果 → 下一步」三段：配错令牌/公钥时，用户第一眼
 * 要能看出「这次到底连的是哪个云、用的是哪来的公钥」。
 */

/** 退出码：2 = 环境不完整（与降级护栏同口径），让 CI 直接判步骤失败 */
const EXIT_INCOMPLETE = 2;

export interface SopSyncCommandInput {
  readonly settings: SopRemoteSettings;
  readonly cacheEnv: SopCacheEnv;
  readonly now?: Date;
}

/** 执行同步命令，返回进程退出码（0 成功 / 2 环境不完整） */
export async function runSopSyncCommand(
  input: SopSyncCommandInput,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const { settings, cacheEnv } = input;
  const target = resolveSopWriteDir(cacheEnv);
  const previous = readSyncMeta(target.dir)?.version;

  for (const line of formatSyncHeader(settings, target, previous)) log(line);
  for (const problem of settings.problems) log(`        ⚠ ${problem}`);

  const result = await syncRulesFromCloud({
    sopBase: settings.sopBase,
    targetDir: target.dir,
    ...(settings.token !== undefined ? { token: settings.token } : {}),
    ...(settings.publicKey !== undefined ? { publicKey: settings.publicKey } : {}),
    allowUnsigned: settings.allowUnsigned,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  for (const line of formatSyncResult(result, settings, previous)) log(line);
  return result.ok ? 0 : EXIT_INCOMPLETE;
}

/** 头部：连哪个云、令牌与公钥从哪来、落到哪 —— 配错时第一眼看的就是这三行 */
function formatSyncHeader(
  settings: SopRemoteSettings,
  target: { dir: string; origin: string },
  previous: string | undefined,
): string[] {
  const lines = ['[CLI] 云端规则同步'];
  lines.push(`        · 接口 ${settings.sopBase}`);
  lines.push(`        · 令牌 ${settings.tokenSource}`);
  lines.push(`        · 验签公钥 ${settings.publicKeySource}`);
  lines.push(`        · 落点 ${target.dir}（${target.origin}）`);
  if (previous) lines.push(`        · 本地现有版本 ${previous}`);
  if (settings.allowUnsigned) {
    lines.push(`        ⚠ ${ALLOW_UNSIGNED_ENV} 已开启：未签名规则也会被采纳，规则来源无法验证`);
  }
  return lines;
}

function formatSyncResult(
  result: SopSyncResult,
  settings: SopRemoteSettings,
  previous: string | undefined,
): string[] {
  if (!result.ok) {
    const lines = [`[CLI] 同步失败（阶段：${stageLabel(result.stage)}）— ${result.reason}`];
    if (result.detail) lines.push(`        · ${result.detail}`);
    lines.push('[CLI] 未写入任何规则：本地缓存保持原样，本次不产生新的门禁结论');
    return lines;
  }

  const transition = previous === undefined ? '首次同步' : previous === result.version ? '版本未变，已重新落盘' : `由 ${previous} 更新`;
  const lines = [
    `[CLI] 同步完成 — 云端版本 ${result.version}（${transition}）`,
    `        · ${result.ruleCount} 条规则 / ${result.domains.length} 个模块（${result.domains.join(', ')}）`,
    `        · 验签 ${result.signed ? '通过' : `跳过（${ALLOW_UNSIGNED_ENV}）`}`,
  ];
  lines.push(...formatGateHint(result.gateCount, settings));
  return lines;
}

/**
 * 门禁规则条数的提示。
 *
 * 必须说清楚「同步成功 ≠ 门禁有结论」：云端版本里若没有 `guard.block.official.*`，
 * 扫描时的门禁段依旧只有「规则集不含门禁」这一句话，而用户刚看到同步成功，
 * 很容易把随后的绿灯当成门禁通过。
 */
function formatGateHint(gateCount: number, settings: SopRemoteSettings): string[] {
  if (gateCount > 0) {
    return [
      `        · 其中扫描后门禁 ${gateCount} 条 — 下次扫描（--sop）会用它们判定`,
      '[CLI] 下一步: zhshield inspect --sop（CI 里建议同时设 ZH_GATE_REQUIRE_SOP=1）',
    ];
  }
  return [
    '        ⚠ 本次规则集不含扫描后门禁规则 — 同步成功，但扫描时门禁阶段仍不会有结论',
    settings.allowUnsigned
      ? '[CLI] 若这是内网自建服务端，请确认其规则库已导入 guard.block.official.* 门禁规则'
      : '[CLI] 请确认云端规则库已发布 guard.block.official.* 门禁规则',
  ];
}

/** 阶段名的人话（输出里直接打 `public-key` 会让人以为要自己配置文件名） */
function stageLabel(stage: string): string {
  switch (stage) {
    case 'public-key':
      return '验签公钥';
    case 'version':
      return '版本探测';
    case 'download':
      return '规则包下载';
    case 'verify':
      return '签名校验';
    case 'write':
      return '本地落盘';
    case 'empty':
      return '空规则集';
    default:
      return stage;
  }
}
