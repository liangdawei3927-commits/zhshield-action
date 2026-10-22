import { randomUUID } from 'node:crypto';
import { relative, join, dirname, resolve, isAbsolute } from 'node:path';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type {
  RuleEvaluation,
  Violation,
  RequiredContentInstruction,
} from '../sop/_meta/rule-evaluation';
import { readFileSafe, isSafeRegexPattern } from './scan-utils';
import { forEachScanTarget } from './inline-eval-scan-target';

// ─── 内联评估：required-content ────────────────────────

export async function evalRequiredContent(
  rule: SopRule,
  instr: RequiredContentInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const violations: Violation[] = [];
  for (const item of instr.items) {
    if (item.jsdocOn && item.jsdocOn.length > 0) {
      violations.push(...checkRequiredJsdoc(rule, item, context));
    } else {
      violations.push(...checkRequiredFile(rule, item, context));
    }
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message:
      violations.length > 0 ? `缺少必需内容 ${violations.length} 处 (${rule.id})` : undefined,
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
}

/** 单文件必需内容检查：文件存在 + contains/containsAny/json */
function checkRequiredFile(
  rule: SopRule,
  item: RequiredContentInstruction['items'][number],
  context: RuleContext,
): Violation[] {
  const violations: Violation[] = [];
  const filePath = join(context.repoRoot, item.path);
  const relativePath = relative(context.repoRoot, filePath);

  const content = readFileSafe(filePath);
  if (content === null) {
      violations.push(
        makeRequiredViolation({
          rule,
          file: relativePath,
          line: 0,
          message: `缺少必需文件: ${item.path}`,
          suggestion: `补充 ${item.path}`,
        }),
      );
    return violations;
  }

  const lower = content.toLowerCase();
  for (const sub of item.contains ?? []) {
    if (!lower.includes(sub.toLowerCase())) {
      violations.push(
        makeRequiredViolation({
          rule,
          file: relativePath,
          line: 0,
          message: `缺少必需内容: "${sub}"`,
          suggestion: `在 ${item.path} 中补充 "${sub}" 相关章节`,
        }),
      );
    }
  }
  for (const group of item.containsAny ?? []) {
    const hit = group.some((sub) => lower.includes(sub.toLowerCase()));
    if (!hit) {
      violations.push(
        makeRequiredViolation({
          rule,
          file: relativePath,
          line: 0,
          message: `缺少必需章节（任一即可）: ${group.join(' / ')}`,
          suggestion: `在 ${item.path} 中补充相关章节`,
        }),
      );
    }
  }
  violations.push(...checkRequiredJson(rule, item, filePath, relativePath));
  return violations;
}

/** JSON(C) 键路径期望值检查：解析失败/键缺失/值不符均为违规 */
function checkRequiredJson(
  rule: SopRule,
  item: RequiredContentInstruction['items'][number],
  filePath: string,
  relativePath: string,
): Violation[] {
  const violations: Violation[] = [];
  const entries = Object.entries(item.json ?? {});
  if (entries.length === 0) return violations;

  const raw = readFileSafe(filePath);
  if (raw === null) return violations;

  const parsed = parseJsoncSafe(raw);
  if (parsed === undefined) {
    violations.push(
      makeRequiredViolation({
        rule,
        file: relativePath,
        line: 0,
        message: `${item.path} 无法解析为 JSON`,
        suggestion: '修复 JSON 语法错误',
      }),
    );
    return violations;
  }

  const effective = resolveEffectiveConfig(filePath, parsed);
  violations.push(...checkJsonKeyPaths({ rule, item, relativePath, effective, entries }));
  return violations;
}

/**
 * tsconfig extends 支持：strict 等开关常定义在被 extends 的 base 配置里，
 * 只查本文件会对这类合理项目误报「缺少配置项」。评估键路径前先沿 extends
 * 链深合并出生效配置；链不可解析时回退为只查本文件（原有行为）。
 */
function resolveEffectiveConfig(filePath: string, parsed: unknown): unknown {
  return typeof parsed === 'object' && parsed !== null
    ? resolveExtendsChain(filePath, parsed as Record<string, unknown>)
    : parsed;
}

interface CheckJsonKeyPathsParams {
  rule: SopRule;
  item: RequiredContentInstruction['items'][number];
  relativePath: string;
  effective: unknown;
  entries: [string, unknown][];
}

function checkJsonKeyPaths(params: CheckJsonKeyPathsParams): Violation[] {
  const { rule, item, relativePath, effective, entries } = params;
  const violations: Violation[] = [];
  for (const [keyPath, expected] of entries) {
    const actual = getJsonPathValue(effective, keyPath);
    if (actual === undefined || actual !== expected) {
      violations.push(
        makeRequiredViolation({
          rule,
          file: relativePath,
          line: 0,
          message: `${item.path} 缺少配置项 ${keyPath} (期望 ${JSON.stringify(expected)})`,
          suggestion: `在 ${item.path} 中设置 ${keyPath}: ${JSON.stringify(expected)}`,
        }),
      );
    }
  }
  return violations;
}

/** JSONC 行注释（须排除 URL 中的 `//`，且注释行内不含引号），配合 parseJsoncSafe 剥离 */
const RE_JSONC_LINE_COMMENT = /(^|[^:])\/\/(?!.*["']).*$/;

/** 解析 JSONC（剥离行/块注释与尾逗号），失败返回 undefined */
function parseJsoncSafe(raw: string): unknown {
  const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments
    .split('\n')
    .map((line) => line.replace(RE_JSONC_LINE_COMMENT, '$1'))
    .join('\n');
  const noTrailingCommas = noLineComments.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailingCommas);
  } catch {
    return undefined;
  }
}

/** 按点分键路径取值（如 compilerOptions.strict），路径不存在返回 undefined */
function getJsonPathValue(root: unknown, keyPath: string): unknown {
  let current: unknown = root;
  for (const segment of keyPath.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * 沿 tsconfig 的 extends 链深合并出生效配置。
 *
 * - extends 支持相对路径（相对当前文件目录）与 node_modules 包路径
 *   （如 "@tsconfig/strictest/tsconfig.json"，无扩展名时按 TS 规则补 .json）；
 * - 对象深合并（base 在下、子配置覆盖），数组与标量直接覆盖；
 * - 循环 extends 以 visited 集合截断；任何一环不可读/不可解析即停止向上合并，
 *   已合并到的部分仍然生效（优于整条链作废）。
 */
function resolveExtendsChain(
  filePath: string,
  self: Record<string, unknown>,
): Record<string, unknown> {
  const chain: Record<string, unknown>[] = [self];
  const visited = new Set<string>([filePath]);
  let currentDir = dirname(filePath);
  let node: Record<string, unknown> | null = self;

  while (node && typeof node.extends === 'string') {
    const target = resolveExtendsTarget(currentDir, node.extends);
    if (!target || visited.has(target)) break;
    visited.add(target);
    const raw = readFileSafe(target);
    if (raw === null) break;
    const parsed = parseJsoncSafe(raw);
    if (parsed === undefined || typeof parsed !== 'object' || parsed === null) break;
    node = parsed as Record<string, unknown>;
    chain.push(node);
    currentDir = dirname(target);
  }

  chain.reverse(); // base 放前面，越靠近子配置越晚合并（覆盖力越强）

  const merged: Record<string, unknown> = {};
  for (const layer of chain) deepMergeInto(merged, layer);
  return merged;
}

/** 解析一个 extends 目标为绝对文件路径；不可解析返回 null */
function resolveExtendsTarget(fromDir: string, spec: string): string | null {
  const withExt = spec.endsWith('.json') ? spec : `${spec}.json`;
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(fromDir, withExt);
  if (isAbsolute(spec)) return withExt;
  // 包路径：@tsconfig/strictest/tsconfig.json 或 @tsconfig/node18（补 tsconfig.json）
  const pkgPath = spec.endsWith('.json') ? spec : `${spec}/tsconfig.json`;
  return resolve(fromDir, 'node_modules', pkgPath);
}

/** 对象递归合并：源对象的键覆盖目标；嵌套对象逐层合并，数组/标量直接替换 */
function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      deepMergeInto(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/** jsdocOn 批量检查：命中声明正则的导出行必须有前置 JSDoc（上一非空行以块注释结束符结尾） */
function checkRequiredJsdoc(
  rule: SopRule,
  item: RequiredContentInstruction['items'][number],
  context: RuleContext,
): Violation[] {
  const violations: Violation[] = [];
  const compiled = compileJsdocPatterns(item.jsdocOn ?? []);
  if (compiled.length === 0) return violations;

  forEachScanTarget(context, item.fileExts, item.excludePatterns, (content, relativePath) => {
    violations.push(...scanJsdocInFile(content, relativePath, rule, compiled));
  });
  return violations;
}

function compileJsdocPatterns(patterns: string[]): RegExp[] {
  return patterns
    .filter((p) => isSafeRegexPattern(p))
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

function scanJsdocInFile(
  content: string,
  relativePath: string,
  rule: SopRule,
  compiled: RegExp[],
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!compiled.some((re) => re.test(lines[i]))) continue;
    if (!hasPrecedingJsdoc(lines, i)) {
      violations.push(
        makeRequiredViolation({
          rule,
          file: relativePath,
          line: i + 1,
          message: `导出声明缺少 JSDoc 注释: ${lines[i].trim().slice(0, 60)}`,
          suggestion: '为导出的接口/类型补充 /** ... */ 文档注释',
        }),
      );
    }
  }
  return violations;
}

/** 判定第 i 行（0 基）前是否有紧邻的 JSDoc 块：最近的非空行以块注释结束符结尾即视为已文档化 */
function hasPrecedingJsdoc(lines: string[], index: number): boolean {
  for (let j = index - 1; j >= 0 && index - j <= 4; j--) {
    const trimmed = lines[j].trim();
    if (!trimmed) continue;
    return trimmed.endsWith('*/');
  }
  return false;
}

interface MakeRequiredViolationParams {
  rule: SopRule;
  file: string;
  line: number;
  message: string;
  suggestion: string;
}

function makeRequiredViolation(params: MakeRequiredViolationParams): Violation {
  const { rule, file, line, message, suggestion } = params;
  return {
    id: randomUUID(),
    ruleId: rule.id,
    severity: rule.severity,
    file,
    ...(line > 0 ? { line } : {}),
    message,
    suggestion,
  };
}
