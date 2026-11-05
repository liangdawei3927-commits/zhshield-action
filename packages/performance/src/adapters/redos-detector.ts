/**
 * ReDoS 检测器（redos-detector.ts）
 *
 * 纯静态检测正则表达式里的**灾难性回溯**（ReDoS，CWE-1333）信号：
 * 用 TypeScript 编译器 API 取出正则字面量 / `new RegExp("...")` 的静态字符串，
 * 再离线分析模式文本，命中「不定量词嵌套」这一教科书级 ReDoS 签名即报警。
 *
 * ## 为什么需要它（能力闭环）
 *
 * 性能页空态此前宣称「ReDoS 检测」，但实现证据只有内核 semgrep 资产 `redos.yml`，
 * 而性能域走 `runPerformanceDomain`（原生探测器，不经 SOP 规则引擎）——
 * 那条 semgrep 资产在桌面端**一次都不会被执行**（死资产）。宣称 vs 实现断裂，
 * 用户看到的是「说能查 ReDoS」，实际从不查。本探测器补上真实实现，
 * 让 `performance.redos` 能力从 planned 诚实转 implemented。
 *
 * ## 为什么是原生探测器而非 semgrep 规则
 *
 * 性能域执行路径是 `domain-executor`，`INSPECT_SCOPE_DOMAINS` 不含 performance，
 * 往 SOP 里塞一条 performance 规则会是 orphan（`domain-not-served`）→ CI 门禁红。
 * 且 semgrep 依赖外部二进制，未安装即 skipped = 用户机器上「没查」。原生探测器零外部依赖、
 * 恒定可执行，是桌面端唯一诚实的落地方式。
 *
 * ## 判据（刻意保守，服从误报率约束）
 *
 * 只报「一个分组内部含不定量词（`+`/`*`/`{n,}`），且该分组自身又被不定量词修饰」
 * —— 如 `(a+)+`、`(.*)*`、`(\d+)+`。这是回溯爆炸的直接成因。
 * `(a|b)+` 这类**交替型**重叠需数据流判断，原理上易误报，不报；
 * `(\d+\.)+` 这类真实也确实可能危险，但报为 medium「建议复核」而非阻断。
 *
 * severity=medium、autoFixable=false：期望人工复核，不做机器自动改写正则（改写风险极高）。
 */
import * as path from 'path';
import * as ts from 'typescript';
import { DEFAULT_CONFIG, type PerformanceConfig, type PerformanceIssue } from '../types';
import {
  resolveSourceRoots,
  collectFilesAcrossRoots,
  collectSourceFiles,
  readTextSafe,
  SOURCE_EXTS,
  SKIPPED_SOURCE_DIRS,
} from '../source-roots';
import { scriptKindOf } from './ast-nodes';

/** 命中的正则：模式文本 + 起始行（1 基） */
interface RegexHit {
  pattern: string;
  line: number;
}

/** ReDoS 检测器契约：对项目根执行静态正则回溯风险分析并产出性能问题列表 */
export interface RedosDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[];
}

/** 正则字面量节点文本形如 `/pattern/flags`：取首个 `/` 与最后一个 `/` 之间的模式 */
function patternOfRegexLiteral(text: string): string | null {
  const lastSlash = text.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  return text.slice(1, lastSlash);
}

/** 从 `new RegExp("...")` / `RegExp("...")` 的首个字符串实参取模式；非静态字符串返回 null */
function patternOfRegExpCall(node: ts.CallExpression | ts.NewExpression): string | null {
  const callee = node.expression;
  const isRegExpCtor = ts.isIdentifier(callee) && callee.text === 'RegExp';
  if (!isRegExpCtor) return null;
  const [first] = node.arguments ?? [];
  if (first === undefined) return null;
  if (ts.isStringLiteralLike(first)) return first.text;
  return null;
}

/**
 * 收集单文件内的所有正则（字面量 + `RegExp("字面量")`）。
 * 纯静态：只读 AST 文本，不执行被扫描代码；畸形源码按已解析部分返回，不抛异常。
 */
function collectRegexHits(sourceFile: ts.SourceFile): RegexHit[] {
  const hits: RegexHit[] = [];
  const visit = (node: ts.Node): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (ts.isRegularExpressionLiteral(node)) {
      const pattern = patternOfRegexLiteral(node.getText(sourceFile));
      if (pattern !== null) hits.push({ pattern, line });
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const pattern = patternOfRegExpCall(node);
      if (pattern !== null) hits.push({ pattern, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

/** 一个字符类 `[...]`：跳过内部（含转义），返回 `]` 之后的下标 */
function skipCharClass(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i += 1;
  if (pattern[i] === ']') i += 1; // 紧跟 [ 的 ] 是字面量
  while (i < pattern.length) {
    if (pattern[i] === '\\') {
      i += 2;
      continue;
    }
    if (pattern[i] === ']') return i + 1;
    i += 1;
  }
  return i;
}

/** 读取位置 idx 处的量词；返回是否不定（`*`/`+`/`{n,}`）与结束位置，非量词返回 null */
function readQuantifier(pattern: string, idx: number): { unbounded: boolean; end: number } | null {
  const c = pattern[idx];
  if (c === '*' || c === '+') return { unbounded: true, end: idx + 1 };
  if (c === '?') return { unbounded: false, end: idx + 1 };
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(idx));
    if (m === null) return null;
    const hasComma = m[2] !== undefined;
    const upper = m[3] ?? '';
    return { unbounded: hasComma && upper === '', end: idx + m[0].length };
  }
  return null;
}

/** 跳过 `(?...)` 分组修饰符（`?:`/`?=`/`?!`/`?<name>`/`?<=`/`?<!`），返回 `(` 之后继续的下标 */
function skipGroupModifier(pattern: string, afterParen: number): number {
  if (pattern[afterParen] !== '?') return afterParen;
  let i = afterParen + 1;
  const m = pattern[i];
  if (m === '<') {
    i += 1;
    if (pattern[i] === '=' || pattern[i] === '!') return i + 1; // lookbehind
    while (i < pattern.length && pattern[i] !== '>') i += 1;
    return i + 1; // 跳过命名分组 `>`
  }
  if (m === ':' || m === '=' || m === '!') return i + 1;
  return i;
}

/**
 * 判定一个正则模式是否存在「不定量词嵌套」的灾难性回溯签名。
 *
 * 用一个极小的括号栈：每个分组记录「内部是否出现过不定量词」；
 * 当某分组闭合、内部含不定量词、且其自身紧跟不定量词时，即判定危险。
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const stack: Array<{ containsUnbounded: boolean }> = [{ containsUnbounded: false }];
  const top = (): { containsUnbounded: boolean } =>
    stack[stack.length - 1] as { containsUnbounded: boolean };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      i = skipCharClass(pattern, i);
      continue;
    }
    if (c === '(') {
      stack.push({ containsUnbounded: false });
      i = skipGroupModifier(pattern, i + 1);
      continue;
    }
    if (c === ')') {
      const group = stack.pop() ?? { containsUnbounded: false };
      const q = readQuantifier(pattern, i + 1);
      const nextUnbounded = q?.unbounded ?? false;
      if (group.containsUnbounded && nextUnbounded) return true;
      if (group.containsUnbounded || nextUnbounded) top().containsUnbounded = true;
      i = q !== null ? q.end : i + 1;
      continue;
    }
    const q = readQuantifier(pattern, i);
    if (q !== null) {
      if (q.unbounded) top().containsUnbounded = true;
      i = q.end;
      continue;
    }
    i += 1;
  }
  return false;
}

/** 构造一条 ReDoS 问题（供探测循环调用，保持主方法精简） */
function buildRedosIssue(relFile: string, hit: RegexHit, seq: number): PerformanceIssue {
  const shown = hit.pattern.length > 80 ? `${hit.pattern.slice(0, 80)}…` : hit.pattern;
  return {
    id: `performance-redos-${relFile}-${hit.line}-${seq}`,
    ruleId: 'performance.redos.catastrophic-backtracking',
    category: 'regex-safety',
    severity: 'medium',
    file: relFile,
    line: hit.line,
    message:
      `${relFile}:${hit.line} 的正则 /${shown}/ 存在嵌套不定量词，` +
      '疑似灾难性回溯（ReDoS）：恶意输入可使其耗时呈指数级上升，拖垮事件循环',
    suggestion:
      '复核该正则是否存在嵌套重复（如 (a+)+ 、(.*)* ）。改用线性匹配：收窄量词作用范围、' +
      '用互斥字符类消除重叠、或使用具备 ReDoS 防护的正则引擎（如 re2 / safe-regex）',
    autoFixable: false,
  };
}

/**
 * RedosDetectorImpl — 基于 AST 的 ReDoS 检测实现
 *
 * 收集源码中的静态正则并逐一分析回溯风险。文件缺失 / 目录不存在均静默跳过，不抛异常。
 */
export class RedosDetectorImpl implements RedosDetector {
  detect(projectRoot: string, config?: PerformanceConfig): PerformanceIssue[] {
    const cfg: PerformanceConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const issues: PerformanceIssue[] = [];
    const files = collectFilesAcrossRoots(
      resolveSourceRoots(projectRoot),
      (root, limit) => collectSourceFiles(root, SOURCE_EXTS, SKIPPED_SOURCE_DIRS, limit),
      cfg.scanLimit,
    );

    for (const filePath of files) {
      const content = readTextSafe(filePath);
      if (content === null) continue;
      const rel = path.relative(projectRoot, filePath).split(path.sep).join('/');
      this.detectInFile(rel, content, issues);
    }
    return issues;
  }

  private detectInFile(relFile: string, content: string, issues: PerformanceIssue[]): void {
    const sourceFile = ts.createSourceFile(
      relFile,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindOf(relFile),
    );
    let seq = 0;
    for (const hit of collectRegexHits(sourceFile)) {
      if (!hasNestedUnboundedQuantifier(hit.pattern)) continue;
      seq += 1;
      issues.push(buildRedosIssue(relFile, hit, seq));
    }
  }
}
