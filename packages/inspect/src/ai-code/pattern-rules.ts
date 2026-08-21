/**
 * 不安全模式规则集（pattern-rules.ts）
 *
 * Pro 层深度审查规则：AI 生成代码的典型不安全模式（附 E.3 "不安全模式规则集"）。
 * 每个命中输出 AiCodeVuln（ruleId 值域仅 'ai-unsafe-default' | 'ai-boundary-miss'，
 * 幻觉依赖单独由 hallucinated-dependency 产出 'ai-hallucinated-dependency'）。
 */
import type { AiCodeVulnRuleId, AiVulnSeverity } from './types';

/** 规则唯一 id */
export type PatternRuleId =
  | 'ai-ts-suppression'
  | 'ai-empty-catch'
  | 'ai-eslint-disable'
  | 'ai-empty-hooks-deps'
  | 'ai-hardcoded-credential'
  | 'ai-eval'
  | 'ai-new-function'
  | 'ai-any-flood';

/** 单条命中：行号 + 现场片段 */
export interface PatternHit {
  line: number;
  snippet: string;
}

/** 模式规则：匹配函数 + 漏洞元数据（07 协议 fix 直接消费） */
export interface PatternRule {
  id: PatternRuleId;
  ruleId: Exclude<AiCodeVulnRuleId, 'ai-hallucinated-dependency'>;
  severity: AiVulnSeverity;
  description: string;
  fix: string;
  match: (content: string) => readonly PatternHit[];
}

/** any-flood：单文件 `: any` / `as any` / `<any>` 出现次数阈值 */
const ANY_FLOOD_THRESHOLD = 5;

function matchLineNumbers(content: string, regex: RegExp): PatternHit[] {
  const hits: PatternHit[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    regex.lastIndex = 0;
    if (regex.test(line)) hits.push({ line: i + 1, snippet: line.trim().slice(0, 80) });
  });
  return hits;
}

/** 逐规则匹配函数（内容级，调用方负责按文件读取） */
const MATCHERS: Record<Exclude<PatternRuleId, 'ai-any-flood'>, (content: string) => readonly PatternHit[]> = {
  'ai-ts-suppression': (content) => matchLineNumbers(content, /@ts-ignore|@ts-nocheck|@ts-expect-error/g),
  'ai-empty-catch': (content) => matchLineNumbers(content, /catch\s*\([^)]*\)\s*\{\s*\}/g),
  'ai-eslint-disable': (content) => matchLineNumbers(content, /\/\/\s*eslint-disable(?:-next-line|-line)?(?:\s|$)/g),
  'ai-empty-hooks-deps': (content) => matchLineNumbers(content, /use(?:Effect|Memo|Callback|LayoutEffect)\([^)]*\[\s*\]\s*\)/g),
  'ai-hardcoded-credential': (content) =>
    matchLineNumbers(
      content,
      /(?:password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\s*[:=]\s*['"][^'"]+['"]/gi,
    ),
  'ai-eval': (content) => matchLineNumbers(content, /\beval\s*\(/g),
  'ai-new-function': (content) => matchLineNumbers(content, /\bnew\s+Function\s*\(/g),
};

/** any-flood：文件级统计，命中一次输出一条（行号为首个命中） */
function matchAnyFlood(content: string): readonly PatternHit[] {
  const re = /\bany\b/g;
  const lines = content.split(/\r?\n/);
  let count = 0;
  let firstLine = 0;
  lines.forEach((line, i) => {
    re.lastIndex = 0;
    while (re.exec(line) !== null) count += 1;
    if (count >= ANY_FLOOD_THRESHOLD && firstLine === 0) firstLine = i + 1;
  });
  if (count < ANY_FLOOD_THRESHOLD) return [];
  return [{ line: firstLine, snippet: `${count} 'any' occurrences in file` }];
}

/** 不安全模式规则集（导出供 review.ts 消费；id 即规则唯一键） */
export const PATTERN_RULES: readonly PatternRule[] = [
  {
    id: 'ai-ts-suppression',
    ruleId: 'ai-unsafe-default',
    severity: 'high',
    description: 'TypeScript suppression directives (@ts-ignore / @ts-nocheck / @ts-expect-error) bypass type safety',
    fix: 'Resolve the underlying type error instead of suppressing it; if truly necessary, document why with a short comment',
    match: MATCHERS['ai-ts-suppression'],
  },
  {
    id: 'ai-empty-catch',
    ruleId: 'ai-boundary-miss',
    severity: 'medium',
    description: 'Empty catch block silently swallows errors',
    fix: 'Log the error and handle the failure path explicitly instead of swallowing it',
    match: MATCHERS['ai-empty-catch'],
  },
  {
    id: 'ai-eslint-disable',
    ruleId: 'ai-boundary-miss',
    severity: 'low',
    description: 'eslint-disable comment disables lint gates on this line',
    fix: 'Remove the disable and fix the underlying issue; keep the rule enabled',
    match: MATCHERS['ai-eslint-disable'],
  },
  {
    id: 'ai-empty-hooks-deps',
    ruleId: 'ai-boundary-miss',
    severity: 'medium',
    description: 'React hook invoked with an empty dependency array may miss updates',
    fix: 'Add the required dependencies to the array, or restructure to avoid stale closures',
    match: MATCHERS['ai-empty-hooks-deps'],
  },
  {
    id: 'ai-hardcoded-credential',
    ruleId: 'ai-unsafe-default',
    severity: 'high',
    description: 'Hardcoded credential-like literal (password / secret / api key / token)',
    fix: 'Move the secret to an environment variable or a secret manager and revoke the leaked value',
    match: MATCHERS['ai-hardcoded-credential'],
  },
  {
    id: 'ai-eval',
    ruleId: 'ai-unsafe-default',
    severity: 'high',
    description: 'eval() executes arbitrary strings at runtime (code injection risk)',
    fix: 'Replace with JSON.parse or a restricted parser; never eval untrusted input',
    match: MATCHERS['ai-eval'],
  },
  {
    id: 'ai-new-function',
    ruleId: 'ai-unsafe-default',
    severity: 'high',
    description: 'new Function() compiles code from strings at runtime',
    fix: 'Avoid dynamic code compilation; use explicit logic or a sandboxed evaluator',
    match: MATCHERS['ai-new-function'],
  },
  {
    id: 'ai-any-flood',
    ruleId: 'ai-unsafe-default',
    severity: 'low',
    description: `Excessive 'any' usage in file (>= ${ANY_FLOOD_THRESHOLD}) indicates bypassed type checks`,
    fix: 'Replace ' + `'any'` + ' with precise types or generics to restore type safety',
    match: matchAnyFlood,
  },
];
