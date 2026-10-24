import * as fs from 'node:fs';
import * as path from 'node:path';
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

// ─── 再导出边过滤（2026-10-24）────────────────────────────────────────────
//
// 背景：ts-prune 把再导出语句（export {...} from './y'）里的符号判为「导出了
// 但没人 import」。它只看了「谁从**这个**文件 import 该符号」，没看「符号本身
// 在别处是否活着」。实测本仓 desktop + shared 两包：脱噪后 258 条命中里 220 条
// （85%）都是这一类；逐条核实全部为误报——符号在叶子模块内部被使用，只是没人
// 从 barrel 这个路径 import。
//
// 判据：一条命中若落在「带 moduleSpecifier 的 export 语句」行范围内，且该语句
// 导出的名字里包含此符号，则它是**再导出边**而非死代码。死代码应当报在定义处，
// 报在过路点没有意义，故丢弃。
//
// 明确的代价（写在这里，不是静默）：
//   · 某符号若只被 barrel 再导出、全项目无人使用，ts-prune 会把它算作「被
//     barrel 引用」而不再在定义处报告，过滤后便无人报它。
//   · 这与规则已有的 ignore 项 (^|/)index\.ts: 属同一取舍（那条注释记着实测
//     465 → 0），本函数只是把该取舍推广到所有 barrel，不再靠文件名枚举。
//
// 安全属性：**fail-open**。文件读不到、语句不闭合、名字对不上，一律保留原条目
// 照常上报。解析器出 bug 的最坏结果 = 退回改动前的行为，绝不允许出现「一次
// bug 把死代码检测静默清零」。

/** 再导出语句的行区间与它导出的名字（1-based，闭区间） */
interface ReExportStatement {
  startLine: number;
  endLine: number;
  names: Set<string>;
}

/** 语句不闭合时的搜索上限，防止畸形文件把扫描拖成全文件遍历 */
const MAX_RE_EXPORT_BLOCK_LINES = 300;

/** 语句头：export * / export { / export type * / export type { */
const RE_EXPORT_HEAD = /^\s*export\s+(type\s+)?(\*|\{)/;
/** 本地定义头：export function/const/interface/type Foo = ... 等，不是再导出 */
const RE_LOCAL_DEFINITION_HEAD =
  /^\s*export\s+(default\b|function\b|async\b|class\b|abstract\b|const\b|let\b|var\b|interface\b|enum\b|declare\b|type\s+[A-Za-z_$])/;
/** 结尾判据：出现 from '...' 或 from "..." */
const RE_FROM_CLAUSE = /\bfrom\s+['"]/;

const statementCache = new Map<string, ReExportStatement[] | null>();

/** 清空缓存（测试用；运行时按路径缓存，进程内文件视为不变） */
export function resetReExportStatementCache(): void {
  statementCache.clear();
}

/** 从一条完整再导出语句里取出「对外暴露的名字」（取 as 之后的别名） */
function extractExportedNames(statement: string): Set<string> {
  const names = new Set<string>();
  const braceStart = statement.indexOf('{');
  const braceEnd = statement.lastIndexOf('}');
  if (braceStart < 0 || braceEnd <= braceStart) return names;
  for (const part of statement.slice(braceStart + 1, braceEnd).split(',')) {
    let name = part.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    name = name.replace(/^type\s+/, '');
    const alias = name.match(/\sas\s+([A-Za-z_$][\w$]*)$/);
    names.add(alias ? alias[1] : name);
  }
  return names;
}

/**
 * 扫描一个文件里的全部再导出语句。
 * 返回 null 表示**无法判定**（读不到文件），调用方必须 fail-open 保留条目。
 */
function collectReExportStatements(absPath: string): ReExportStatement[] | null {
  const cached = statementCache.get(absPath);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    statementCache.set(absPath, null);
    return null;
  }

  const lines = text.split(/\r?\n/);
  const out: ReExportStatement[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!RE_EXPORT_HEAD.test(head) || RE_LOCAL_DEFINITION_HEAD.test(head)) continue;

    // 从语句头往下找 from 子句；找不到 ⇒ 本地再导出（export { a, b };），不是边
    let end = -1;
    const limit = Math.min(lines.length, i + MAX_RE_EXPORT_BLOCK_LINES);
    for (let j = i; j < limit; j++) {
      if (RE_FROM_CLAUSE.test(lines[j])) {
        end = j;
        break;
      }
      // 语句还没闭合就又开了新语句 ⇒ 畸形，放弃这条（fail-open）
      if (j > i && RE_EXPORT_HEAD.test(lines[j])) break;
    }
    if (end < 0) continue;

    out.push({
      startLine: i + 1,
      endLine: end + 1,
      names: extractExportedNames(lines.slice(i, end + 1).join('\n')),
    });
    i = end;
  }

  statementCache.set(absPath, out);
  return out;
}

/** 过滤结果：kept 仍需上报，dropped 为再导出边 */
export interface ReExportFilterResult {
  kept: PruneEntry[];
  dropped: PruneEntry[];
}

/**
 * 把落在再导出语句里的命中剥离出来。
 *
 * projectRoot 用于把 ts-prune 输出的相对路径解析成绝对路径（ts-prune 以
 * projectPath 为 cwd 输出相对路径）。
 */
export function filterReExportEdges(
  entries: readonly PruneEntry[],
  projectRoot: string,
): ReExportFilterResult {
  const kept: PruneEntry[] = [];
  const dropped: PruneEntry[] = [];

  for (const entry of entries) {
    const absPath = path.isAbsolute(entry.file) ? entry.file : path.resolve(projectRoot, entry.file);
    const statements = collectReExportStatements(absPath);
    if (statements === null) {
      kept.push(entry);
      continue;
    }
    const isEdge = statements.some(
      (s) => entry.line >= s.startLine && entry.line <= s.endLine && s.names.has(entry.symbol),
    );
    (isEdge ? dropped : kept).push(entry);
  }

  return { kept, dropped };
}

// ─── 内联 import 类型引用过滤（2026-10-25）────────────────────────────────
//
// 背景：TypeScript 允许在类型位置直接写 `import('./m').T` 取某模块的导出
// 类型，不产生任何顶层 import 语句。ts-prune 只统计顶层 import / export
// 语句形成的引用边，因此这类导出会被判成「没人引用」。
//
// 实测本仓：带规则 toolConfig 全仓扫描、经再导出过滤后剩 2 条，逐条核实
// 全部是这一形态（ProjectOnboardingPage-hooks.ts / -steps.tsx 用内联
// import 取 ProjectOnboardingPage-types.ts 的两个接口）。属分析器能力边界，
// 不是死代码，也不是规则写错。
//
// 与再导出过滤的关键差异：这一层是**正向找证据**（在全项目里搜到一条真实
// 内联引用记录才丢弃），不是按文件名 / 路径形状猜测。风险方向因此相反：
// 解析失败的结果是「找不到证据 → 照报」，即多报而非漏报。
//
// 安全属性同样是 fail-open：specifier 非相对路径（包名 / @zh 路径别名）静态
// 无法定位、文件读不到、目录不可读、规模超限，一律保留原条目。

/** 内联 import 类型引用：import('./m').T（含 typeof import(...) 形态） */
const INLINE_IMPORT_TYPE_REF = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/;

/** 扫描时跳过的目录：与适配器 accessScope 的排除口径保持一致 */
const INLINE_REF_EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'release',
  '.turbo',
  '.next',
]);

const INLINE_REF_SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** 单文件大小上限：超过视为不可分析而跳过（该文件少一条证据，不影响判定方向） */
const INLINE_REF_MAX_BYTES = 2 * 1024 * 1024;

/** 文件数上限：超过则放弃整轮过滤，宁可多报也不误吞 */
const INLINE_REF_MAX_FILES = 50_000;

/**
 * 把相对 specifier 解析为磁盘上的真实文件。
 * 只处理相对路径：包名 / 路径别名（形如 @scope/pkg）静态无法定位 ⇒ 返回 null，
 * 交由「解析不出 ⇒ 不过滤」的 fail-open 分支处理。
 */
export function resolveRelativeModuleFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  // 同时尝试「带扩展名」与「省略扩展名」，以及 TypeScript 的 .js → .ts 写法
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选不存在：继续下一个
    }
  }
  return null;
}

/** 递归收集待扫描源文件（绝对路径）。返回 false 表示触达文件数上限、本轮不完整 */
function collectInlineRefCandidates(dir: string, out: string[], limit: number): boolean {
  if (out.length >= limit) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true; // 目录不可读：跳过该目录，不中止整轮
  }
  for (const entry of entries) {
    if (out.length >= limit) return false;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (INLINE_REF_EXCLUDED_DIRS.has(entry.name)) continue;
      if (!collectInlineRefCandidates(abs, out, limit)) return false;
      continue;
    }
    if (entry.isFile() && INLINE_REF_SOURCE_EXT.has(path.extname(entry.name))) out.push(abs);
  }
  return true;
}

/** 内联 import 引用过滤结果 */
export interface InlineImportFilterResult {
  kept: PruneEntry[];
  dropped: PruneEntry[];
  /** true = 扫描因规模上限中止，全部保留（fail-open，调用方可据此记录降级原因） */
  degraded: boolean;
}

/**
 * 剥离「只被内联 import 类型引用」的命中。
 *
 * projectRoot 用于把 ts-prune 输出的相对路径解析成绝对路径；内联引用的
 * specifier 则以引用所在文件为基准解析——两者都必须落到同一个绝对路径且
 * 符号名精确相等，才判定为已引用。任一环节不确定即保留。
 */
export function filterInlineImportTypeRefs(
  entries: readonly PruneEntry[],
  projectRoot: string,
): InlineImportFilterResult {
  if (entries.length === 0) return { kept: [], dropped: [], degraded: false };

  // 只关心「命中文件 → 该文件被报的符号名」，缩小比对集合
  const targets = new Map<string, Set<string>>();
  for (const entry of entries) {
    const abs = path.isAbsolute(entry.file) ? entry.file : path.resolve(projectRoot, entry.file);
    const set = targets.get(abs);
    if (set) set.add(entry.symbol);
    else targets.set(abs, new Set([entry.symbol]));
  }

  const files: string[] = [];
  if (!collectInlineRefCandidates(projectRoot, files, INLINE_REF_MAX_FILES)) {
    return { kept: [...entries], dropped: [], degraded: true };
  }

  const referenced = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      if (fs.statSync(file).size > INLINE_REF_MAX_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 单个文件读不到：少一条证据，不影响判定方向
    }
    const re = new RegExp(INLINE_IMPORT_TYPE_REF.source, 'g');
    for (const match of text.matchAll(re)) {
      const specifier = match[1];
      const symbol = match[2];
      if (!specifier || !symbol) continue;
      const target = resolveRelativeModuleFile(file, specifier);
      if (target === null) continue;
      const symbols = targets.get(target);
      if (!symbols || !symbols.has(symbol)) continue;
      referenced.add(`${target}\u0000${symbol}`);
    }
  }

  const kept: PruneEntry[] = [];
  const dropped: PruneEntry[] = [];
  for (const entry of entries) {
    const abs = path.isAbsolute(entry.file) ? entry.file : path.resolve(projectRoot, entry.file);
    (referenced.has(`${abs}\u0000${entry.symbol}`) ? dropped : kept).push(entry);
  }
  return { kept, dropped, degraded: false };
}
