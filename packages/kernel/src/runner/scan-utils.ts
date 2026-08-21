import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { Violation } from '../sop/_meta/rule-evaluation';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';

/** 跳过的大文件阈值 (1MB) */
const MAX_FILE_SIZE = 1_048_576;

/** 测试文件匹配模式 */
const TEST_FILE_PATTERN = /\.(test|spec|mocks?)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** 行级注释匹配 */
const COMMENT_RE = /^\s*(?:\/\/|\/\*|\*|#)/;

/** 字符串字面量内容匹配 */
const STRING_CONTENT_RE = /^\s*['"`].*['"`]\s*[,\]]?\s*$/;

/** 判断是否非代码行（注释或字符串字面量） */
function isNonCodeLine(line: string): boolean {
  return COMMENT_RE.test(line) || STRING_CONTENT_RE.test(line);
}

/**
 * 解析待扫描的文件列表
 */
export function resolveFiles(context: RuleContext, exts?: string[]): string[] {
  const shouldSkip = (filePath: string): boolean => {
    if (TEST_FILE_PATTERN.test(filePath)) return true;
    if (filePath.includes('/__tests__/') || filePath.includes('/__mocks__/')) return true;
    if (filePath.includes('/dist/')) return true;
    return false;
  };

  if (context.files && context.files.length > 0) {
    return context.files.filter((f) => {
      if (shouldSkip(f)) return false;
      if (!exts || exts.length === 0) return true;
      return exts.some((e) => f.endsWith(e));
    });
  }

  const srcDir = path.join(context.repoRoot, 'src');
  if (!fs.existsSync(srcDir)) return [];

  return collectFiles(srcDir, exts);
}

function collectFiles(dir: string, exts?: string[]): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '__mocks__' || entry.name === 'dist') continue;
      files.push(...collectFiles(fullPath, exts));
      continue;
    }
    if (!entry.isFile()) continue;
    if (TEST_FILE_PATTERN.test(entry.name)) continue;
    if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) continue;
    if (!exts || exts.length === 0 || exts.some((e) => entry.name.endsWith(e))) {
      files.push(fullPath);
    }
  }
  return files;
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
export function scanPatternsInFile(content: string, relativePath: string, rule: SopRule, patterns: string[], locale?: LanguageCode): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const patternStr of patterns) {
    violations.push(...scanPatternInLines(patternStr, lines, relativePath, rule, locale));
  }

  return violations;
}

function scanPatternInLines(
  patternStr: string,
  lines: string[],
  relativePath: string,
  rule: SopRule,
  locale?: LanguageCode,
): Violation[] {
  const regex = compileRegex(patternStr);
  if (!regex) return [];

  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isNonCodeLine(lines[i])) continue;
    violations.push(...scanLineMatches({ regex, line: lines[i], lineNumber: i + 1, relativePath, rule }, locale));
  }
  return violations;
}

function compileRegex(patternStr: string): RegExp | null {
  try {
    return new RegExp(patternStr, 'g');
  } catch {
    // 正则无效则跳过
    return null;
  }
}

/** scanLineMatches 参数对象 */
interface ScanLineMatchesParams {
  regex: RegExp;
  line: string;
  lineNumber: number;
  relativePath: string;
  rule: SopRule;
}

function scanLineMatches(params: ScanLineMatchesParams, locale?: LanguageCode): Violation[] {
  const { regex, line, lineNumber, relativePath, rule } = params;
  const violations: Violation[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex for each line
  regex.lastIndex = 0;
  while ((match = regex.exec(line)) !== null) {
    violations.push({
      id: randomUUID(),
      ruleId: rule.id,
      severity: rule.severity,
      file: relativePath,
      line: lineNumber,
      column: match.index + 1,
      message: translate('engine.kernel.runner.sensitivePatternMatch', locale ?? DEFAULT_LANGUAGE, {
        match: match[0].slice(0, 80),
      }),
      suggestion: translate('engine.kernel.runner.removeHardcodedValue', locale ?? DEFAULT_LANGUAGE),
      match: match[0].slice(0, 120),
    });
  }
  return violations;
}

const REGEX_LITERAL_RE = /\/[^/\n]+\/[gimsuy]*/g;
const REGEX_LIKE_RE = /\/[^/\n]+\/[gimsuy]*\s*[;,)}\]]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildForbiddenRegex(pattern: string): RegExp | null {
  try {
    if (pattern.includes(' ') || pattern.includes('->')) {
      return new RegExp(escapeRegExp(pattern), 'g');
    }
    const firstChar = pattern[0];
    if (firstChar && /\w/.test(firstChar)) {
      return new RegExp(`\\b${escapeRegExp(pattern)}\\b`, 'g');
    }
    return new RegExp(escapeRegExp(pattern), 'g');
  } catch {
    return null;
  }
}

export function scanForbiddenInFile(content: string, relativePath: string, rule: SopRule, patterns: string[], locale?: LanguageCode): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');

  for (const pattern of patterns) {
    const regex = buildForbiddenRegex(pattern);
    if (!regex) continue;

    for (let i = 0; i < lines.length; i++) {
      if (REGEX_LIKE_RE.test(lines[i])) continue;
      regex.lastIndex = 0;
      const match = regex.exec(lines[i]);
      if (match) {
        violations.push({
          id: randomUUID(),
          ruleId: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: i + 1,
          column: match.index + 1,
          message: translate('engine.kernel.runner.forbiddenUsage', locale ?? DEFAULT_LANGUAGE, { pattern }),
          suggestion: translate('engine.kernel.runner.replaceForbidden', locale ?? DEFAULT_LANGUAGE, { pattern }),
          match: lines[i].trim().slice(0, 120),
        });
      }
    }
  }

  return violations;
}

/** 根据文件路径判断所属层级（按层名匹配目录） */
export function detectLayer(filePath: string, layers: Array<{ name: string; allowedDependencies: string[] }>): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const layer of layers) {
    if (new RegExp(`/${layer.name}/`, 'i').test(normalized)) {
      return layer.name;
    }
  }
  return null;
}

/** 根据导入的模块名判断目标层级 */
export function detectLayerByName(moduleName: string, layers: Array<{ name: string; allowedDependencies: string[] }>): string | null {
  const lower = moduleName.toLowerCase();
  for (const layer of layers) {
    if (lower === layer.name.toLowerCase() || lower.includes(layer.name.toLowerCase())) {
      return layer.name;
    }
  }
  return null;
}
