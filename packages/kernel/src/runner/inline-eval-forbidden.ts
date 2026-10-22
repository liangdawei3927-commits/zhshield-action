import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  ForbiddenPatternInstruction,
  ForbiddenRegexInstruction,
} from '../sop/_meta/rule-evaluation';
import { scanForbiddenInFile, isSafeRegexPattern } from './scan-utils';
import { forEachScanTarget } from './inline-eval-scan-target';

// ─── 内联评估：forbidden ───────────────────────────────

// 规则级白名单条目（.zhshield/whitelist.yml 的 rule 段），用于压制自检误报
interface WhitelistRuleEntry {
  ruleId: string;
  pattern: string;
}

// 复用常量避免每次调用重复创建（eslint-performance）；
// 与 guard WhitelistManager 的解析语义一致（键名不锚定行首，可匹配 "- rule: ..."）
const YAML_SECTION_HEADER_RE = /^[a-zA-Z]+:$/;
const RULE_KEY_VALUE_RE = /rule:\s*['"]?(.+?)['"]?$/;
const PATTERN_KEY_VALUE_RE = /pattern:\s*['"]?(.+?)['"]?$/;

/** 加载项目根目录 .zhshield/whitelist.yml 的 rule 段条目（文件缺失时为 []） */
function loadRuleWhitelist(repoRoot: string): WhitelistRuleEntry[] {
  const filePath = join(repoRoot, '.zhshield', 'whitelist.yml');
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: WhitelistRuleEntry[] = [];
  let section = '';
  let current: WhitelistRuleEntry | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (YAML_SECTION_HEADER_RE.test(line)) {
      section = line.slice(0, -1);
      current = null;
      continue;
    }
    if (section !== 'rule') continue;
    const ruleMatch = line.match(RULE_KEY_VALUE_RE);
    if (ruleMatch) {
      current = { ruleId: ruleMatch[1], pattern: '' };
      entries.push(current);
      continue;
    }
    const patternMatch = line.match(PATTERN_KEY_VALUE_RE);
    if (patternMatch && current) current.pattern = patternMatch[1];
  }
  return entries;
}

/** 规则级白名单匹配：ruleId 一致且文件路径包含 pattern（与 guard WhitelistManager 语义一致） */
function isRuleWhitelisted(
  entries: WhitelistRuleEntry[],
  ruleId: string,
  filePath: string,
): boolean {
  return entries.some((e) => e.ruleId === ruleId && (!e.pattern || filePath.includes(e.pattern)));
}

/** forbidden / forbidden-regex 共用的指令投影（仅需文件过滤与排除模式） */
interface ForbiddenScanScope {
  fileExts?: string[];
  excludePatterns?: string[];
}

export async function evalForbidden(
  rule: SopRule,
  instr: ForbiddenPatternInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  return scanForbiddenScope(rule, instr, context, (content, relativePath) =>
    scanForbiddenInFile(content, relativePath, rule, instr.patterns),
  );
}

/** forbidden / forbidden-regex 的共同实现：逐文件扫描 → 规则级白名单过滤 → 构造评估结果 */
async function scanForbiddenScope(
  rule: SopRule,
  instr: ForbiddenScanScope,
  context: RuleContext,
  scanFile: (content: string, relativePath: string) => Violation[],
): Promise<RuleEvaluation> {
  const whitelist = loadRuleWhitelist(context.repoRoot);
  const violations: Violation[] = [];

  forEachScanTarget(context, instr.fileExts, instr.excludePatterns, (content, relativePath) => {
    for (const v of scanFile(content, relativePath)) {
      if (!isRuleWhitelisted(whitelist, rule.id, v.file)) violations.push(v);
    }
  });

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message: violations.length > 0 ? `发现 ${violations.length} 处禁止模式 (${rule.id})` : undefined,
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
}

// ─── 内联评估：forbidden-regex ─────────────────────────

/** 正则禁止项编译结果：编译失败（含 ReDoS 危险形态）静默跳过，不产生误报 */
interface CompiledForbiddenRegex {
  source: string;
  regex: RegExp;
  message?: string;
  suggestion?: string;
}

export async function evalForbiddenRegex(
  rule: SopRule,
  instr: ForbiddenRegexInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const compiled = compileForbiddenRegexItems(instr.items);
  return scanForbiddenScope(rule, instr, context, (content, relativePath) =>
    scanForbiddenRegexInFile(content, relativePath, rule, compiled),
  );
}

function compileForbiddenRegexItems(
  items: ForbiddenRegexInstruction['items'],
): CompiledForbiddenRegex[] {
  const compiled: CompiledForbiddenRegex[] = [];
  for (const item of items) {
    try {
      if (!isSafeRegexPattern(item.regex)) continue;
      compiled.push({
        source: item.regex,
        regex: new RegExp(item.regex, 'g'),
        ...(item.message ? { message: item.message } : {}),
        ...(item.suggestion ? { suggestion: item.suggestion } : {}),
      });
    } catch {
      // 无效正则跳过
    }
  }
  return compiled;
}

/** 从 from 起定位块注释闭合符的起始下标；未闭合时停在 len-1（调用方 +2 后越界退出） */
function indexOfBlockCommentEnd(line: string, from: number): number {
  let j = from;
  while (j < line.length - 1 && !(line[j] === '*' && line[j + 1] === '/')) j++;
  return j;
}

/** 从 from 起定位引号字面量闭合引号之后的下标（`\\` 转义跳 2，未闭合则返回 len） */
function indexAfterClosingQuote(line: string, from: number, quote: string): number {
  let j = from;
  while (j < line.length) {
    if (line[j] === '\\') {
      j += 2;
    } else if (line[j] === quote) {
      j++;
      break;
    } else {
      j++;
    }
  }
  return j;
}

/** 单行剥离结果：保留的代码语义内容 + 更新后的跨行模板状态 */
interface StripLineResult {
  result: string;
  inTemplate: boolean;
}

/** 跨行模板字符串内消费一个字符：返回更新后的下标与闭合状态（转义跳 2、未闭合则原样继续） */
function consumeTemplateChar(
  line: string,
  i: number,
  inTemplate: boolean,
): { i: number; inTemplate: boolean } {
  if (line[i] === '\\') return { i: i + 2, inTemplate };
  if (line[i] === '`') return { i: i + 1, inTemplate: false };
  return { i: i + 1, inTemplate };
}

/**
 * 剥离单行中的字符串字面量与注释，仅保留代码语义内容。
 * 返回本行保留的字符与更新后的跨行模板状态（未闭合反引号延续到下一行）。
 */
function stripLine(line: string, inTemplate: boolean): StripLineResult {
  let result = '';
  let i = 0;
  while (i < line.length) {
    if (inTemplate) {
      const next = consumeTemplateChar(line, i, inTemplate);
      i = next.i;
      inTemplate = next.inTemplate;
      continue;
    }
    if (line[i] === '/' && line[i + 1] === '/') break;
    if (line[i] === '/' && line[i + 1] === '*') {
      i = indexOfBlockCommentEnd(line, i + 2) + 2;
      continue;
    }
    if (line[i] === "'" || line[i] === '"') {
      const q = line[i];
      i = indexAfterClosingQuote(line, i + 1, q);
      continue;
    }
    if (line[i] === '`') {
      // 进入模板字符串：若同行未闭合则状态延续至后续行
      inTemplate = true;
      i++;
      continue;
    }
    result += line[i];
    i++;
  }
  return { result, inTemplate };
}

/**
 * 剥离字符串字面量和注释，仅保留代码语义内容。
 * 用于 forbidden-regex 扫描前预处理，避免正则匹配到字符串/注释中的子串。
 *
 * 处理范围：// 行注释、/* 块注释、' " 字符串字面量（含转义）。
 * 跨行模板字符串（`...`）按状态机跨行剥离：未闭合反引号延续到后续行，
 * 避免服务器渲染 HTML/JS 等跨行模板内容被误当作代码语义扫描
 * （09-24 修复：admin-pages-view.ts 的 `<script>` 内联 JS 曾被误报隐式 any）。
 * 不处理：正则字面量、模板插值（${...}）内部（对 forbidden-regex 场景足够）。
 *
 * @param content 需逐行扫描的文件内容
 * @returns 逐行剥离后对应的行数组（长度与输入行数一致）
 */
function stripStringsAndComments(content: string): string[] {
  const out: string[] = [];
  let inTemplate = false; // 跨行模板字符串状态：true 表示当前位于未闭合反引号内
  for (const line of content.split('\n')) {
    const stripped = stripLine(line, inTemplate);
    inTemplate = stripped.inTemplate;
    out.push(stripped.result);
  }
  return out;
}

/** 禁止正则逐个回调全局匹配项；每次调用前归零 lastIndex，保持原有「逐行重置」语义 */
function forEachGlobalMatch(
  regex: RegExp,
  text: string,
  onMatch: (match: RegExpExecArray) => void,
): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) onMatch(match);
}

function scanForbiddenRegexInFile(
  content: string,
  relativePath: string,
  rule: SopRule,
  compiled: CompiledForbiddenRegex[],
): Violation[] {
  const violations: Violation[] = [];
  const lines = stripStringsAndComments(content);
  for (const item of compiled) {
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i];
      forEachGlobalMatch(item.regex, stripped, (match) => {
        violations.push({
          id: randomUUID(),
          ruleId: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: i + 1,
          column: match.index + 1,
          message: item.message ?? `命中禁止正则: ${item.source.slice(0, 80)}`,
          suggestion: item.suggestion ?? '按项目规范调整该处代码',
          match: stripped.trim().slice(0, 120),
        });
      });
    }
  }
  return violations;
}
