/**
 * 项目文件系统访问工具（files.ts）
 *
 * 只读访问：递归枚举源码文件（剪枝 node_modules/.git/dist 等）、逐行提取
 * import/require 包名、枚举本地 node_modules 已装包。静态分析只读文件，
 * 不执行项目代码（P0-2 禁令）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';

const NEWLINE_RE = /\r?\n/;

/** 扫描的源码扩展名（MVP 聚焦 TS/JS 生态） */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** 递归遍历时剪枝的目录名（与产物/依赖/元数据目录同名一律跳过） */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '00-项目文档',
  '__tests__',
  '__mocks__',
  '.zhshield',
  '.omo',
  '.playwright-mcp',
  '.workbuddy',
  'test-results',
  'e2e',
]);

const TEST_FILE_PATTERN = /\.(test|spec|mocks)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** 单个 import/require 引用：包名 + 出处 */
export interface ImportReference {
  packageName: string;
  file: string;
  line: number;
}

/**
 * 读取文本文件；缺失/不可读视为"不存在"返回 null。
 * 边界 fallback（同 env-consistency 既有做法），非吞错。
 */
export function readTextFileSafe(projectPath: string, relPath: string): string | null {
  try {
    return fs.readFileSync(safeJoin(projectPath, relPath), 'utf-8');
  } catch {
    return null;
  }
}

/** 读取并解析 JSON 文件；缺失/解析失败返回 null（边界 fallback） */
export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function walkDir(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不可读：跳过
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 隐藏项（含 .git）
    const rel = safeJoin(base, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkDir(safeJoin(dir, entry.name), rel, out);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      if (TEST_FILE_PATTERN.test(entry.name)) continue;
      out.push(rel.split(path.sep).join('/'));
    }
    // 符号链接目录不递归（避免环），符号链接文件按文件处理之外的路径忽略
  }
}

/** 递归枚举项目源码文件（相对路径，'/'-分隔）；项目根不可读返回空数组 */
export function walkSourceFiles(projectPath: string): string[] {
  const files: string[] = [];
  walkDir(projectPath, '', files);
  return files.sort();
}

/** 相对路径是否命中 scope 前缀过滤（scope 为空表示不过滤） */
export function isInScope(relPath: string, scope?: readonly string[]): boolean {
  if (scope === undefined || scope.length === 0) return true;
  return scope.some((s) => relPath === s || relPath.startsWith(`${s}/`));
}

const SPECIFIER_RE =
  /(?:import|export)[^;\n]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const LINE_COMMENT_RE = /^\s*\/\//;

function extractSpecifiers(line: string): string[] {
  if (LINE_COMMENT_RE.test(line)) return [];
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  SPECIFIER_RE.lastIndex = 0;
  while ((m = SPECIFIER_RE.exec(line)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

/** Node 内置模块：无需声明也不会幻觉 */
const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/** 模块说明符 → 包名；相对/绝对/node:/Node 内置返回 null（不是外部包） */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts[0] === '' || parts[1] === undefined || parts[1] === '') return null;
    const name = `${parts[0]}/${parts[1]}`; // '@scope/pkg/sub' → '@scope/pkg'
    return NODE_BUILTINS.has(name) ? null : name;
  }
  const first = specifier.split('/')[0];
  if (first === undefined || first === '' || NODE_BUILTINS.has(first)) return null;
  return first; // 'lodash/fp' → 'lodash'
}

/** 单行内提取的 import/require 引用追加到 refs（保持行内出现顺序） */
function collectLineRefs(refs: ImportReference[], file: string, lineNumber: number, line: string): void {
  for (const spec of extractSpecifiers(line)) {
    const pkg = packageNameFromSpecifier(spec);
    if (pkg === null) continue;
    refs.push({ packageName: pkg, file, line: lineNumber });
  }
}

/** 扫描项目全部源码文件，提取外部包 import/require 引用 */
export function extractImportReferences(projectPath: string, scope?: readonly string[]): ImportReference[] {
  const refs: ImportReference[] = [];
  for (const file of walkSourceFiles(projectPath)) {
    if (!isInScope(file, scope)) continue;
    const content = readTextFileSafe(projectPath, file);
    if (content === null) continue;
    const lines = content.split(NEWLINE_RE);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      collectLineRefs(refs, file, i + 1, line);
    }
  }
  return refs;
}

const NODE_MODULES_SKIP: ReadonlySet<string> = new Set([
  '.bin',
  '.pnpm',
  '.package-lock.json',
  '.yarn-integrity',
  'package-lock.json',
]);

/** 枚举本地 node_modules 顶层已装包名（含 @scope 下的 scoped 包）；无 node_modules 返回空集 */
export function listNodeModules(projectPath: string): ReadonlySet<string> {
  const names = new Set<string>();
  const nm = safeJoin(projectPath, 'node_modules');
  let topLevel: string[];
  try {
    topLevel = fs.readdirSync(nm);
  } catch {
    return names;
  }
  for (const entry of topLevel) {
    if (NODE_MODULES_SKIP.has(entry)) continue;
    if (entry.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = fs.readdirSync(safeJoin(nm, entry));
      } catch {
        continue;
      }
      for (const sub of scoped) names.add(`${entry}/${sub}`);
    } else {
      names.add(entry);
    }
  }
  return names;
}
