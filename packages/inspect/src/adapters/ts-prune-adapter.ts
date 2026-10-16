import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  AccessScope,
} from '@zh/shared';
import { safeJoin } from '@zh/shared';
import {
  asToolExecError,
  buildAccessScope,
  buildToolResult,
  execTool,
  ToolCommandResolver,
} from './tool-runner';

/** overlay tsconfig 文件名（monorepo 聚合扫描用）。写在与项目同根但 git 忽略的临时区，扫描后清理 */
const MONOREPO_OVERLAY_FILE = '.zhshield/tsconfig.ts-prune.monorepo.json';

/** 测试目录排除项匹配（测试是合法消费者，不再整体排除；仅跳过确属产物的部分） */
const SRC_TESTS_EXCLUDE_RE = /(^|\/)src\/__tests__\/?$/;

/**
 * monorepo overlay tsconfig。
 *
 * 背景（2026-09-21 实测确认）：ts-prune 用 `-p tsconfig.json` 相对 projectPath 运行，在 monorepo
 * 里命中仓库根 tsconfig —— 根 tsconfig 无 include 字段 → 全仓 TS 全量纳入（含脚本/夹具），无
 * jsx 支持 → .tsx 全量解析失败，无 DOM lib → 前端类型报错覆盖解析，且各包 @zh/* 路径映射断裂 →
 * App.tsx/PageShell/ScoreRing/getOrg 等被系统性误报为死代码。
 *
 * 解法：聚合各包 tsconfig 的 include/paths/exclude 为单一 overlay，jsx:preserve + DOM lib +
 * @zh/* 文件级 paths 指向各包 src/index.ts，单次执行（实测 ~17-25s / 858 条，6/6 已知符号判定正确）。
 */
export interface MonorepoPruneOverlay {
  compilerOptions: {
    target: string;
    module: string;
    moduleResolution: string;
    lib: readonly string[];
    jsx: string;
    strict: boolean;
    esModuleInterop: boolean;
    skipLibCheck: boolean;
    resolveJsonModule: boolean;
    noEmit: boolean;
    allowImportingTsExtensions: boolean;
    isolatedModules: boolean;
    baseUrl: string;
    paths: Record<string, string[]>;
  };
  include: string[];
  exclude: string[];
}

/** 逐包 tsconfig 中 overlay 需要继承的字段 */
interface PackageTsConfigShape {
  include?: string[];
  exclude?: string[];
  compilerOptions?: { paths?: Record<string, string[]> };
}

/** overlay 固定的编译选项（聚合语义，与单包编译无关） */
const OVERLAY_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  jsx: 'preserve',
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  isolatedModules: true,
} as const;

/**
 * JSONC→严格 JSON：仅在字符串外剥离行注释与块注释，保留字符串原样。
 *
 * 背景：autoperf 的 tsconfig.json 含 `// P7 试点` 注释（2026-09-21 实测），直接 JSON.parse
 * 会抛错 → 该包被静默跳过。注意必须识别字符串状态——裸正则 `//[^\n]*` 会误删字符串内的
 * `https://...` 等。状态机逐字符扫描，仅字符串外且遇 \ 转义时跳过两字符。
 */
function stripJsoncComments(raw: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += raw[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 聚合 monorepo 各包 tsconfig 为单一 overlay，供 ts-prune 单次扫描。
 *
 * ⚠️ TS 路径解析基准不同（2026-09-21 实测确认，写错会静默扫描 0 文件）：
 *   · include/exclude —— 相对 **tsconfig 文件自身目录**（overlay 在 .zhshield/，故须 '../' 前缀指回项目根）；
 *   · baseUrl —— 相对 tsconfig 目录，设 '..' = 项目根；
 *   · paths —— 相对 **baseUrl**（= 项目根），故值用 './packages/...'，不能再带 '../'（会双重上跳）。
 * include 逐包追加；exclude 逐包聚合；paths 改写各包别名并映射 src/index.ts 为 @zh/<pkg>。
 * 非 monorepo（无 packages/<pkg>/tsconfig.json）→ null，调用方保持根 tsconfig.json 原行为。
 */
export function buildMonorepoPruneOverlay(
  projectPath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = fs.existsSync,
): MonorepoPruneOverlay | null {
  const packagesRoot = path.join(projectPath, 'packages');
  const pkgDirs = readPackageDirs(packagesRoot);
  if (pkgDirs === null) return null;

  const { relRoot, fromConfigDir, fromBaseUrl } = createOverlayPathHelpers(projectPath);
  const { include, exclude, paths, foundPackage } = collectPackageOverlay(pkgDirs, {
    packagesRoot,
    fromConfigDir,
    fromBaseUrl,
    readFile,
    exists,
  });
  if (!foundPackage || include.length === 0) return null;

  return assembleOverlay(relRoot, paths, include, exclude);
}

/** 读取 packages 目录下的条目；目录不存在/不可读时返回 null */
function readPackageDirs(packagesRoot: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * 计算 overlay 路径辅助函数。
 * fromConfigDir：overlay 所在目录（projectPath/.zhshield）到项目根的相对前缀（include/exclude 用）；
 * fromBaseUrl：paths 相对 baseUrl（= 项目根），带 './' 前缀，并归一化包内 './src/*' 等冗余写法。
 */
function createOverlayPathHelpers(projectPath: string): {
  relRoot: string;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
} {
  const overlayDir = path.dirname(path.join(projectPath, MONOREPO_OVERLAY_FILE));
  const relRoot = (path.relative(overlayDir, projectPath) || '.').split(path.sep).join('/');
  const fromConfigDir = (p: string): string => path.posix.join(relRoot, p);
  const fromBaseUrl = (p: string): string => `./${path.posix.normalize(p)}`;
  return { relRoot, fromConfigDir, fromBaseUrl };
}

/** collectPackageOverlay 的参数对象：包根目录、路径辅助函数与文件访问器 */
interface CollectPackageOverlayParams {
  packagesRoot: string;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
}

/** aggregatePackage 的参数对象：包根目录、文件访问器、聚合目标集合与路径辅助函数 */
interface AggregatePackageParams {
  packagesRoot: string;
  readFile: (p: string) => string;
  include: string[];
  exclude: Set<string>;
  paths: Record<string, string[]>;
  fromConfigDir: (p: string) => string;
  fromBaseUrl: (p: string) => string;
}

/** aggregatePackageIncludes 的参数对象：包 tsconfig、聚合目标集合与路径辅助函数 */
interface AggregatePackageIncludesParams {
  cfg: PackageTsConfigShape;
  include: string[];
  exclude: Set<string>;
  fromConfigDir: (p: string) => string;
}

/** 逐包聚合 include/exclude/paths 与包入口映射 */
function collectPackageOverlay(
  pkgDirs: fs.Dirent[],
  params: CollectPackageOverlayParams,
): {
  include: string[];
  exclude: Set<string>;
  paths: Record<string, string[]>;
  foundPackage: boolean;
} {
  const { packagesRoot, fromConfigDir, fromBaseUrl, readFile, exists } = params;
  const include: string[] = [];
  const exclude = new Set([
    fromConfigDir('node_modules'),
    fromConfigDir('**/dist'),
    fromConfigDir('**/build'),
  ]);
  const paths: Record<string, string[]> = {};
  let foundPackage = false;

  for (const dirent of pkgDirs) {
    if (!dirent.isDirectory()) continue;
    const pkg = dirent.name;
    const pkgTsConfig = path.join(packagesRoot, pkg, 'tsconfig.json');
    if (!exists(pkgTsConfig)) continue;
    foundPackage = true;
    aggregatePackage(pkg, {
      packagesRoot,
      readFile,
      include,
      exclude,
      paths,
      fromConfigDir,
      fromBaseUrl,
    });
  }

  return { include, exclude, paths, foundPackage };
}

/** 聚合单个包：解析 tsconfig 后并入 include/exclude/paths 与包入口映射 */
function aggregatePackage(pkg: string, params: AggregatePackageParams): void {
  const { packagesRoot, readFile, include, exclude, paths, fromConfigDir, fromBaseUrl } = params;
  const pkgTsConfig = path.join(packagesRoot, pkg, 'tsconfig.json');
  const cfg = parsePackageTsConfig(pkgTsConfig, readFile);
  if (cfg === null) return;

  aggregatePackageIncludes(pkg, { cfg, include, exclude, fromConfigDir });
  aggregatePackagePaths(pkg, cfg, paths, fromBaseUrl);
}

/** 解析包 tsconfig（JSONC 容错：剥离注释后 JSON.parse）；坏配置返回 null */
function parsePackageTsConfig(
  pkgTsConfig: string,
  readFile: (p: string) => string,
): PackageTsConfigShape | null {
  try {
    return JSON.parse(stripJsoncComments(readFile(pkgTsConfig))) as PackageTsConfigShape;
  } catch {
    return null;
  }
}

/**
 * 聚合单个包的 include/exclude 到 overlay 集合。
 *
 * include 必须覆盖「测试」与「包根配置」两类合法消费者，否则它们对导出的引用不构成
 * 使用证据，会把有真实调用方的导出误判为死代码：
 *   · 各包 tsconfig 的 `include: ["src"]` 不含包根，而 vitest.config.ts 位于包根，
 *     导致 shared/src/vitest.config.base.ts 的 makeVitestConfig/packagesDir 零可见引用。
 *   · 各包 `exclude: ["src/__tests__"]` 把测试移出 program，而测试常是某导出唯一的消费者。
 * 仅排除编译产物（.js / .d.ts / dist）：它们是 include 通配带入的重复副本，
 * 参与分析会互相"引用"并掩盖真实死代码。
 */
function aggregatePackageIncludes(pkg: string, params: AggregatePackageIncludesParams): void {
  const { cfg, include, exclude, fromConfigDir } = params;
  const pkgIncludes = asStringArray(cfg.include);
  const scope = pkgIncludes.length > 0 ? pkgIncludes : ['src'];
  for (const inc of scope) {
    include.push(fromConfigDir(`packages/${pkg}/${inc}/**/*`));
  }
  // 包根配置文件（vitest.config.ts 等）不在 include 范围内，但它们是共享源码的真实消费者
  include.push(fromConfigDir(`packages/${pkg}/*.ts`));

  for (const ex of asStringArray(cfg.exclude)) {
    // 测试目录是合法消费者，不再整体排除；仅保留其中确属产物的部分
    if (SRC_TESTS_EXCLUDE_RE.test(ex)) continue;
    exclude.add(fromConfigDir(`packages/${pkg}/${ex}`));
  }
  // include 的 `**/*` 会带入同目录的 .js/.d.ts 编译产物，排除后只剩真实 TS 源码
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.d.ts`));
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.js`));
  exclude.add(fromConfigDir(`packages/${pkg}/**/*.js.map`));
}

/**
 * 聚合单个包的 paths 别名与包入口映射。
 *
 * `@zh/<pkg>` 无条件注册，不加 src/index.ts 存在性判断：映射指向不存在的文件与没有映射
 * 对解析结果等价（都会回退到常规解析），而门控会让 barrel 缺失的包丢失映射，使其全部
 * 导出被误判为死代码 —— 少一个文件被放大成整包误报，门控没有收益只有风险。
 */
function aggregatePackagePaths(
  pkg: string,
  cfg: PackageTsConfigShape,
  paths: Record<string, string[]>,
  fromBaseUrl: (p: string) => string,
): void {
  const pkgPaths = cfg.compilerOptions?.paths;
  if (pkgPaths) {
    for (const [alias, targets] of Object.entries(pkgPaths)) {
      paths[alias] = asStringArray(targets).map((t) => fromBaseUrl(`packages/${pkg}/${t}`));
    }
  }

  paths[`@zh/${pkg}`] = [fromBaseUrl(`packages/${pkg}/src/index.ts`)];
}

/** 组装最终 overlay 结构 */
function assembleOverlay(
  relRoot: string,
  paths: Record<string, string[]>,
  include: string[],
  exclude: Set<string>,
): MonorepoPruneOverlay {
  const sortedExclude: string[] = [];
  for (const item of exclude) sortedExclude.push(item);
  sortedExclude.sort();
  return {
    compilerOptions: { ...OVERLAY_COMPILER_OPTIONS, baseUrl: relRoot, paths },
    include: include.sort(),
    exclude: sortedExclude,
  };
}

const META: ToolMeta = {
  id: 'ts-prune',
  name: 'ts-prune',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: 'TypeScript 死代码/未导出检测',
  cliCommand: 'ts-prune',
  homepage: 'https://github.com/nadeesha/ts-prune',
  license: 'MIT',
};

/**
 * ts-prune 输出行格式（2026-09-18 实测 ts-prune@0.10.x）。
 *
 * 真机输出用「破折号」分隔，不是冒号：
 *   src/orphan.ts:1 - neverImportedAnywhere
 * 历史/变体格式用冒号：
 *   src/orphan.ts:1: neverImportedAnywhere
 *
 * 🔴 事故记录：本适配器此前只有 /^(.+?):(\d+):\s*(.+)$/（只认冒号），而真实输出是
 *   破折号 → 每一行 parse 都返回 null → issues 恒为 [] → tool-dispatch 判
 *   `available && issues.length===0` → 规则显示「工具 ts-prune 检查通过」。
 *   即「死代码检测」长期静默零检出、永远打勾。成因是 mapOutput 无任何测试覆盖
 *   （既有 ts-prune-adapter.test.ts 只测 isAvailable）。两种分隔符都必须显式支持。
 */
const TS_PRUNE_DASH_LINE = /^(.+?):(\d+)\s+-\s+(.+)$/;
const TS_PRUNE_COLON_LINE = /^(.+?):(\d+):\s*(.+)$/;

/**
 * ts-prune 对「仅被本模块自己引用」的导出会加此后缀（如
 * `vitest.shared.ts:37 - createVitestConfig (used in module)`）。
 * 该类符号**确有调用方**，不属死代码；不过滤会在每个项目上产生海量假阳性。
 */
const USED_IN_MODULE = /\s*\(used in module\)\s*$/;

interface PruneEntry {
  file: string;
  line: number;
  symbol: string;
}

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
  const cfg = options.config as Record<string, unknown> | undefined;
  const skip = asStringArray(cfg?.skip);
  if (skip.length > 0) args.push('-s', joinRegexes(skip));
  const ignore = asStringArray(cfg?.ignore);
  if (ignore.length > 0) args.push('-i', joinRegexes(ignore));
  return args;
}

export class TsPruneAdapter implements ToolAdapter {
  meta = META;
  private readonly commands: ToolCommandResolver;

  /** F5：ts-prune 基于 tsconfig 分析 TS 源码的未导出符号 */
  readonly accessScope: AccessScope = buildAccessScope(['**/*.{ts,tsx}', '**/tsconfig.json']);

  constructor(projectRoot?: string) {
    this.commands = new ToolCommandResolver('ts-prune', projectRoot);
  }

  async isAvailable(): Promise<boolean> {
    // ts-prune 的 `--version` 不短路：会连同参数当作项目扫描真实执行（实测输出为全量
    // 未导出报告而非版本号），>20s 超时 → isCommandAvailable 误判未安装。
    // 改为检查解析出的命令文件存在且可执行（解析链已覆盖本地 bin / PATH / zhshield bin）。
    try {
      const command = await this.commands.resolve();
      if (path.isAbsolute(command)) {
        await fs.promises.access(command, fs.constants.X_OK);
        return true;
      }
      return findExecutableOnPath(command);
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runTsPrune(options, start);
    } catch (error: unknown) {
      return this.handleTsPruneError(error, start);
    }
  }

  /** 执行 ts-prune 并映射输出为可用结果 */
  private async runTsPrune(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const { projectPath, overlay, overlayAbsPath, tsConfigPath, command } =
      await this.resolveTsPruneConfig(options);

    try {
      await writeOverlayFile(overlay, overlayAbsPath);
      const { stdout } = await execTool(command, buildTsPruneArgs(options, tsConfigPath), {
        cwd: projectPath,
        timeout: options.timeout || 60000,
      });
      return this.buildAvailableResult(stdout, start);
    } finally {
      await cleanupOverlay(overlay, overlayAbsPath);
    }
  }

  /**
   * 归一化 projectPath 并解析 overlay / tsconfig / 命令路径。
   * 归一化 projectPath 为绝对路径：相对路径会流入 cwd 与 tsconfig 相对化，
   * ts-prune 以自身 cwd 解析相对路径导致扫描失败。
   * monorepo 聚合 overlay：修复根 tsconfig 无 jsx/DOM/路径映射导致的系统性死代码误报
   * （App.tsx/PageShell/getOrg 等假阳性；实测单次 ~17-25s，6/6 已知符号正确）。
   * 非 monorepo（无 packages/<pkg>/tsconfig.json）时 buildMonorepoPruneOverlay 返回 null → 原行为。
   * ts-prune@0.10.3 runner 内部用 path.join(process.cwd(), tsConfigPath) 组装路径，
   * 传绝对路径会翻倍（cwd/projectPath + 绝对路径）；cwd 已是 projectPath，故传相对路径。
   * 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析。
   */
  private async resolveTsPruneConfig(options: ToolScanOptions): Promise<{
    projectPath: string;
    overlay: MonorepoPruneOverlay | null;
    overlayAbsPath: string;
    tsConfigPath: string;
    command: string;
  }> {
    const projectPath = path.resolve(options.projectPath);
    const overlay = buildMonorepoPruneOverlay(projectPath);
    const overlayAbsPath = overlay
      ? path.resolve(projectPath, MONOREPO_OVERLAY_FILE)
      : path.resolve(projectPath, 'tsconfig.json');
    const tsConfigPath = path.relative(projectPath, overlayAbsPath);
    const command = await this.commands.resolve(projectPath);
    return { projectPath, overlay, overlayAbsPath, tsConfigPath, command };
  }

  /** 将 ts-prune stdout 映射为可用扫描结果 */
  private buildAvailableResult(stdout: string, start: number): ToolResult {
    const issues = this.mapOutput(stdout);
    return buildToolResult({ tool: 'ts-prune', status: 'available', issues, start });
  }

  /** 处理 ts-prune 执行错误：未安装 / 部分输出 / 失败 */
  private handleTsPruneError(error: unknown, start: number): ToolResult {
    const err = asToolExecError(error);
    if (err.code === 'ENOENT') {
      return buildToolResult({
        tool: 'ts-prune',
        status: 'unavailable',
        issues: [],
        start,
        error: 'ts-prune 未安装',
      });
    }

    if (err.stdout) {
      const issues = this.mapOutput(err.stdout);
      if (issues.length > 0) {
        return buildToolResult({ tool: 'ts-prune', status: 'available', issues, start });
      }
    }

    return buildToolResult({
      tool: 'ts-prune',
      status: 'error',
      issues: [],
      start,
      error: err.stderr || err.message || 'ts-prune 执行失败',
    });
  }

  private mapOutput(raw: string): Issue[] {
    return parseTsPruneOutput(raw).map(({ file, line, symbol }) => ({
      id: randomUUID(),
      ruleId: 'ts-prune/unused-export',
      severity: 'info',
      category: 'quality',
      message: `未使用的导出: ${symbol}`,
      file,
      line,
      column: 0,
      suggestion: `移除未使用的导出符号: ${symbol}`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: `ts-prune:${file}:${line}:${symbol}`,
    }));
  }
}

/** 写入 monorepo overlay 临时文件（非 monorepo 时跳过） */
async function writeOverlayFile(
  overlay: MonorepoPruneOverlay | null,
  overlayAbsPath: string,
): Promise<void> {
  if (!overlay) return;
  await fs.promises.mkdir(path.dirname(overlayAbsPath), { recursive: true });
  await fs.promises.writeFile(overlayAbsPath, JSON.stringify(overlay, null, 2), 'utf8');
}

/** 清理 monorepo overlay 临时文件：不污染项目（写入 .zhshield/，git 已忽略） */
async function cleanupOverlay(
  overlay: MonorepoPruneOverlay | null,
  overlayAbsPath: string,
): Promise<void> {
  if (!overlay) return;
  await fs.promises.rm(overlayAbsPath, { force: true }).catch(() => {});
}

/** 裸命令名（PATH 上解析到）：逐 PATH 目录查找可执行文件，避免执行 --version */
async function findExecutableOnPath(command: string): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      // safeJoin: PATH 目录 + 固定命令名/入参，界内行为与 path.join 一致（09-24 path-traversal 清理）
      await fs.promises.access(safeJoin(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // 该目录无此命令，继续下一个 PATH 目录
    }
  }
  return false;
}
