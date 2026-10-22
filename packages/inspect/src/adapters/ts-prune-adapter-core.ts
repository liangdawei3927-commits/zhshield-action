import type { ToolScanOptions } from '@zh/shared';

/** ts-prune 单行解析结果 */
export interface PruneEntry {
  file: string;
  line: number;
  symbol: string;
}

const TS_PRUNE_DASH_LINE = /^(.+?):(\d+)\s+-\s+(.+)$/;
const TS_PRUNE_COLON_LINE = /^(.+?):(\d+):\s*(.+)$/;
/**
 * ts-prune 对"被模块内其他符号引用"的未导出符号会附加 `(used in module)` 标记。
 * 该类符号**确有调用方**，不属死代码；不过滤会在每个项目上产生海量假阳性。
 */
const USED_IN_MODULE = /\s*\(used in module\)\s*$/;
/**
 * 解析单行 ts-prune 输出。返回 null 表示该行不是可用条目
 * （格式不识别，或为 used-in-module 噪音）。
 */
export function parsePruneLine(rawLine: string): PruneEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TS_PRUNE_DASH_LINE) ?? trimmed.match(TS_PRUNE_COLON_LINE);
  if (!match) return null;
  const [, file, lineStr, rawSymbol] = match;
  if (USED_IN_MODULE.test(rawSymbol)) return null;
  const symbol = rawSymbol.replace(USED_IN_MODULE, '').trim();
  if (!symbol) return null;
  return { file: file.trim(), line: parseInt(lineStr, 10) || 0, symbol };
}

/** 解析 ts-prune 完整 stdout（纯文本，逐行） */
export function parseTsPruneOutput(raw: string): PruneEntry[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split('\n')
    .map((line) => parsePruneLine(line))
    .filter((e): e is PruneEntry => e !== null);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 多个正则合并为单个（ts-prune 每次只接受一个 -s / -i RegExp）。单项原样返回，避免多余分组 */
function joinRegexes(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `(${patterns.join('|')})`;
}
/**
 * 组装 ts-prune 命令行参数。
 * 规则可通过 check.toolConfig 声明：
 *   · skip   → -s：判定"是否被使用"时跳过的文件（框架注册型文件，如 NestJS 控制器/模块）
 *   · ignore → -i：从报告中整体排除的路径
 * 二者是规则侧消除误报的唯一手段（NestJS 项目不跳过会产生大量假阳性）。
 */
export function buildTsPruneArgs(options: ToolScanOptions, tsConfigPath: string): string[] {
  // ⚠️ 不带 --json：实机 ts-prune@0.10.x 忽略该开关（仍输出纯文本），而 mapOutput 是
  // 纯文本解析器。保留 --json 意味着「若某版本开始真正生效 → 输出变 JSON → 解析全部失败
  // → 又变成静默零检出」。宁可显式声明只要文本输出，也不要留一个会退化成长的隐患。
  const args = ['-p', tsConfigPath];
  const cfg = (options.config ?? {}) as Record<string, unknown>;
  const skip = asStringArray(cfg.skip);
  if (skip.length > 0) args.push('-s', joinRegexes(skip));
  const ignore = asStringArray(cfg.ignore);
  if (ignore.length > 0) args.push('-i', joinRegexes(ignore));
  return args;
}
