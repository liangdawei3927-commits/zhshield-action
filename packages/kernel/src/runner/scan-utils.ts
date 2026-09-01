import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { Violation } from '../sop/_meta/rule-evaluation';

/** 跳过的大文件阈值 (1MB) */
const MAX_FILE_SIZE = 1_048_576;

/** 正则模式最大长度（防超长输入撑爆回溯） */
const MAX_PATTERN_LENGTH = 512;

/** 灾难性回溯形态：含量词分组后紧跟量词（(a+)+ / (a*)* / (a?)* 等） */
const RE_DANGEROUS_GROUP = /\([^()]*[+*?{][^()]*\)[+*?{]/;

/** 层名安全字符集：仅允许目录名常见字符（字母/数字/连字符/下划线/点） */
const SAFE_LAYER_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** 候选源码根目录：按优先级依次探测，取第一个存在的目录 */
const CANDIDATE_SOURCE_ROOTS = ['src', 'packages', 'app', 'lib', 'cmd', 'internal'];

/** 噪声目录：扫描时跳过（含点开头目录），避免把依赖/构建产物当源码 */
const NOISE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'release',
  '.turbo',
  '.cache',
]);

/** 根目录密度扫描阈值：repoRoot 下直接源码文件数 ≥ 该值才视为源码根 */
const ROOT_DENSITY_THRESHOLD = 3;

/** 递归扫描最大深度（参照 fingerprint 画像 walkFiles 的 12 层） */
const MAX_SCAN_DEPTH = 12;

/** 单次扫描收集文件数上限，超限即停止，防止超大仓库撑爆内存 */
const MAX_SCAN_FILES = 2000;

/** 转义正则特殊字符（层名来自配置，按不可信输入处理） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 正则模式安全校验：拒绝可能导致灾难性回溯（ReDoS）的模式。
 * 仅允许长度受限、括号配对、且不含「含量词分组后紧跟量词」
 * （(a+)+ / (a*)* / (a?)* 等经典灾难性回溯形态）的模式。
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  const stripped = pattern.replace(/\\[^]/g, '').replace(/\[[^\]]*\]/g, 'X');
  if (RE_DANGEROUS_GROUP.test(stripped)) return false;
  let depth = 0;
  for (const c of stripped) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** 将 excludePatterns glob（支持 ** 与 *）编译为正则：**→任意路径段，*→单段内任意字符 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      out += escapeRegExp(pattern[i]);
      i += 1;
    }
  }
  return new RegExp(out);
}

/** 相对路径是否命中任一排除模式（支持 ** 与 * 通配） */
export function matchesExcludePatterns(
  relativePath: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globToRegExp(p).test(relativePath));
}

/**
 * 解析待扫描的文件列表
 */
export function resolveFiles(context: RuleContext, exts?: string[]): string[] {
  if (context.files && context.files.length > 0) {
    return filterByExtensions(context.files, exts);
  }

  const sourceRoot = findSourceRoot(context.repoRoot);
  if (sourceRoot) {
    return collectFiles(sourceRoot, exts);
  }

  if (countSourceFilesAtRoot(context.repoRoot, exts) >= ROOT_DENSITY_THRESHOLD) {
    return collectFiles(context.repoRoot, exts);
  }

  return resolveFromNestedLayout(context.repoRoot, exts);
}

/** 按扩展名过滤显式指定的文件列表 */
function filterByExtensions(files: string[], exts?: string[]): string[] {
  return files.filter((f) => {
    if (!exts || exts.length === 0) return true;
    return exts.some((e) => f.endsWith(e));
  });
}

/** 候选源码根探测：依次尝试常见源码目录，取第一个存在的 */
function findSourceRoot(repoRoot: string): string | null {
  for (const root of CANDIDATE_SOURCE_ROOTS) {
    const candidate = path.join(repoRoot, root);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 嵌套仓库布局回退：在第一层子目录中探测源码根 */
function resolveFromNestedLayout(repoRoot: string, exts?: string[]): string[] {
  for (const child of listChildDirs(repoRoot)) {
    const sourceRoot = findSourceRoot(child);
    if (sourceRoot) {
      return collectFiles(sourceRoot, exts);
    }
  }
  return [];
}

/** 列出目录下第一层子目录（跳过点开头与噪声目录） */
function listChildDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 忽略无权限目录
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || NOISE_DIRS.has(entry.name)) continue;
    dirs.push(path.join(dir, entry.name));
  }
  return dirs;
}

/** 统计 repoRoot 下直接源码文件数（仅一层，不递归，忽略噪声目录） */
function countSourceFilesAtRoot(repoRoot: string, exts?: string[]): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    // 忽略无权限目录
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (NOISE_DIRS.has(entry.name)) continue;
    if (!exts || exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
      count++;
    }
  }
  return count;
}

function collectFiles(dir: string, exts?: string[]): string[] {
  const files: string[] = [];
  walk(dir, exts, 0, files);
  return files;
}

/** 递归收集源码文件：带深度与文件数上限，跳过噪声目录 */
function walk(dir: string, exts: string[] | undefined, depth: number, files: string[]): void {
  if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 忽略无权限目录
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || NOISE_DIRS.has(entry.name)) continue;
      walk(fullPath, exts, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!exts || exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
      files.push(fullPath);
    }
  }
}

/** 安全读取文件内容：二进制 / 超大文件 (>1MB) 返回 null */
export function readFileSafe(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 按正则模式扫描单文件内容，返回所有命中违规 */
export function scanPatternsInFile(
  content: string,
  relativePath: string,
  rule: SopRule,
  patterns: string[],
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const patternStr of patterns) {
    const regex = compileSafeRegex(patternStr);
    if (!regex) continue;
    scanLinesForPattern(lines, regex, relativePath, rule, violations);
  }

  return violations;
}

/** 编译安全正则：无效或危险模式返回 null */
function compileSafeRegex(patternStr: string): RegExp | null {
  try {
    if (!isSafeRegexPattern(patternStr)) return null;
    return new RegExp(patternStr, 'g');
  } catch {
    return null;
  }
}

/** 逐行扫描正则命中并记录违规 */
function scanLinesForPattern(
  lines: string[],
  regex: RegExp,
  relativePath: string,
  rule: SopRule,
  violations: Violation[],
): void {
  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(lines[i])) !== null) {
      violations.push({
        id: randomUUID(),
        ruleId: rule.id,
        severity: rule.severity,
        file: relativePath,
        line: i + 1,
        column: match.index + 1,
        message: `匹配到敏感模式: ${match[0].slice(0, 80)}`,
        suggestion: '移除或使用环境变量替代硬编码值',
        match: match[0].slice(0, 120),
      });
    }
  }
}

/** 裸标识符形态的禁止模式：按整词匹配，避免命中任意/anything/tianyin 等拼写含界符的子串 */
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 扫描单行内容中的禁止模式（子串匹配；裸标识符按整词匹配），记录命中违规 */
function scanLineForForbidden(
  line: string,
  pattern: string,
  isBareIdentifier: boolean,
  relativePath: string,
  rule: SopRule,
  lineNumber: number,
  violations: Violation[],
): void {
  if (isBareIdentifier) {
    const wordRe = new RegExp(`\\b${escapeRegExp(pattern)}\\b`, 'g');
    let match: RegExpExecArray | null;
    while ((match = wordRe.exec(line)) !== null) {
      violations.push({
        id: randomUUID(),
        ruleId: rule.id,
        severity: rule.severity,
        file: relativePath,
        line: lineNumber,
        column: match.index + 1,
        message: `禁止使用: "${pattern}"`,
        suggestion: `移除或替换 "${pattern}" 为类型安全的替代方案`,
        match: line.trim().slice(0, 120),
      });
    }
  } else if (line.includes(pattern)) {
    violations.push({
      id: randomUUID(),
      ruleId: rule.id,
      severity: rule.severity,
      file: relativePath,
      line: lineNumber,
      column: line.indexOf(pattern) + 1,
      message: `禁止使用: "${pattern}"`,
      suggestion: `移除或替换 "${pattern}" 为类型安全的替代方案`,
      match: line.trim().slice(0, 120),
    });
  }
}

/** 扫描单文件内容中的禁止模式（子串匹配；裸标识符按整词匹配），返回所有命中违规 */
export function scanForbiddenInFile(
  content: string,
  relativePath: string,
  rule: SopRule,
  patterns: string[],
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const pattern of patterns) {
    const isBareIdentifier = BARE_IDENTIFIER_RE.test(pattern);
    for (let i = 0; i < lines.length; i++) {
      scanLineForForbidden(
        lines[i],
        pattern,
        isBareIdentifier,
        relativePath,
        rule,
        i + 1,
        violations,
      );
    }
  }

  return violations;
}

/** 根据文件路径判断所属层级（按层名匹配目录） */
export function detectLayer(
  filePath: string,
  layers: Array<{ name: string; allowedDependencies: string[] }>,
): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const layer of layers) {
    if (!SAFE_LAYER_NAME_RE.test(layer.name)) continue;
    if (new RegExp(`/${escapeRegExp(layer.name)}/`, 'i').test(normalized)) {
      return layer.name;
    }
  }
  return null;
}

/** 根据导入的模块名判断目标层级 */
export function detectLayerByName(
  moduleName: string,
  layers: Array<{ name: string; allowedDependencies: string[] }>,
): string | null {
  const lower = moduleName.toLowerCase();
  for (const layer of layers) {
    if (lower === layer.name.toLowerCase() || lower.includes(layer.name.toLowerCase())) {
      return layer.name;
    }
  }
  return null;
}
