import { randomUUID } from 'node:crypto';
import { relative, join } from 'node:path';
import { readFileSync } from 'node:fs';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { GuardEngineLike } from './evaluator-host';
import type {
  RuleEvaluation,
  Violation,
  PatternScanInstruction,
  ThresholdInstruction,
  ForbiddenPatternInstruction,
  ForbiddenRegexInstruction,
  RequiredContentInstruction,
  LayerBoundaryInstruction,
} from '../sop/_meta/rule-evaluation';
import {
  resolveFiles,
  readFileSafe,
  scanPatternsInFile,
  scanForbiddenInFile,
  matchesExcludePatterns,
  isSafeRegexPattern,
  detectLayer,
  detectLayerByName,
} from './scan-utils';

// ─── 内联评估：pattern-scan ────────────────────────────

export async function evalPatternScan(
  rule: SopRule,
  instr: PatternScanInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context, instr.fileExts);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    violations.push(...scanPatternsInFile(content, relativePath, rule, instr.patterns));
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message: violations.length > 0 ? `发现 ${violations.length} 处匹配 (${rule.id})` : undefined,
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

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

export async function evalForbidden(
  rule: SopRule,
  instr: ForbiddenPatternInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context, instr.fileExts);
  const whitelist = loadRuleWhitelist(context.repoRoot);
  const violations = scanForbiddenFiles(files, whitelist, rule, instr, context);

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message:
      violations.length > 0 ? `发现 ${violations.length} 处禁止模式 (${rule.id})` : undefined,
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
}

/** 扫描文件列表中的禁止模式，应用排除与规则级白名单 */
function scanForbiddenFiles(
  files: string[],
  whitelist: WhitelistRuleEntry[],
  rule: SopRule,
  instr: ForbiddenPatternInstruction,
  context: RuleContext,
): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    if (matchesExcludePatterns(relativePath, instr.excludePatterns)) continue;

    for (const v of scanForbiddenInFile(content, relativePath, rule, instr.patterns)) {
      if (!isRuleWhitelisted(whitelist, rule.id, v.file)) violations.push(v);
    }
  }
  return violations;
}

// ─── 内联评估：threshold ───────────────────────────────

export async function evalThreshold(
  rule: SopRule,
  instr: ThresholdInstruction,
  context: RuleContext,
  guardEngine?: GuardEngineLike,
): Promise<RuleEvaluation> {
  const summary = buildThresholdSummary(instr);
  await tryQueryThreshold(guardEngine, rule, context);

  return {
    rule,
    status: 'passed',
    message: `阈值规则 (需要外部数据): ${summary}`,
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

function buildThresholdSummary(instr: ThresholdInstruction): string {
  const thresholdKeys = Object.keys(instr.thresholds);
  return thresholdKeys.length > 0
    ? `阈值: ${thresholdKeys.map((k) => `${k}=${instr.thresholds[k]}`).join(', ')}`
    : `阈值: ${instr.unit ?? ''} ${JSON.stringify(instr.thresholds)}`;
}

async function tryQueryThreshold(
  guardEngine: GuardEngineLike | undefined,
  rule: SopRule,
  context: RuleContext,
): Promise<void> {
  if (!guardEngine || !rule.applicableEngines.includes('guard')) return;
  try {
    await guardEngine.run({
      mode: 'guard',
      target: context.repoRoot,
      checks: [rule.id],
      dryRun: true,
    });
  } catch {
    // 忽略
  }
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
  const files = resolveFiles(context, instr.fileExts);
  const whitelist = loadRuleWhitelist(context.repoRoot);
  const violations = scanForbiddenRegexFiles(
    files,
    whitelist,
    rule,
    instr,
    compiled,
    context.repoRoot,
  );

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message:
      violations.length > 0 ? `发现 ${violations.length} 处禁止模式 (${rule.id})` : undefined,
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
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

function scanForbiddenRegexFiles(
  files: string[],
  whitelist: WhitelistRuleEntry[],
  rule: SopRule,
  instr: ForbiddenRegexInstruction,
  compiled: CompiledForbiddenRegex[],
  repoRoot: string,
): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(repoRoot, filePath);
    if (matchesExcludePatterns(relativePath, instr.excludePatterns)) continue;

    for (const v of scanForbiddenRegexInFile(content, relativePath, rule, compiled)) {
      if (!isRuleWhitelisted(whitelist, rule.id, v.file)) violations.push(v);
    }
  }
  return violations;
}

function scanForbiddenRegexInFile(
  content: string,
  relativePath: string,
  rule: SopRule,
  compiled: CompiledForbiddenRegex[],
): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (const item of compiled) {
    for (let i = 0; i < lines.length; i++) {
      item.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = item.regex.exec(lines[i])) !== null) {
        violations.push({
          id: randomUUID(),
          ruleId: rule.id,
          severity: rule.severity,
          file: relativePath,
          line: i + 1,
          column: match.index + 1,
          message: item.message ?? `命中禁止正则: ${item.source.slice(0, 80)}`,
          suggestion: item.suggestion ?? '按项目规范调整该处代码',
          match: lines[i].trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

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
      makeRequiredViolation(
        rule,
        relativePath,
        0,
        `缺少必需文件: ${item.path}`,
        `补充 ${item.path}`,
      ),
    );
    return violations;
  }

  const lower = content.toLowerCase();
  for (const sub of item.contains ?? []) {
    if (!lower.includes(sub.toLowerCase())) {
      violations.push(
        makeRequiredViolation(
          rule,
          relativePath,
          0,
          `缺少必需内容: "${sub}"`,
          `在 ${item.path} 中补充 "${sub}" 相关章节`,
        ),
      );
    }
  }
  for (const group of item.containsAny ?? []) {
    const hit = group.some((sub) => lower.includes(sub.toLowerCase()));
    if (!hit) {
      violations.push(
        makeRequiredViolation(
          rule,
          relativePath,
          0,
          `缺少必需章节（任一即可）: ${group.join(' / ')}`,
          `在 ${item.path} 中补充相关章节`,
        ),
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
      makeRequiredViolation(
        rule,
        relativePath,
        0,
        `${item.path} 无法解析为 JSON`,
        '修复 JSON 语法错误',
      ),
    );
    return violations;
  }

  for (const [keyPath, expected] of entries) {
    const actual = getJsonPathValue(parsed, keyPath);
    if (actual === undefined || actual !== expected) {
      violations.push(
        makeRequiredViolation(
          rule,
          relativePath,
          0,
          `${item.path} 缺少配置项 ${keyPath} (期望 ${JSON.stringify(expected)})`,
          `在 ${item.path} 中设置 ${keyPath}: ${JSON.stringify(expected)}`,
        ),
      );
    }
  }
  return violations;
}

/** 解析 JSONC（剥离行/块注释与尾逗号），失败返回 undefined */
function parseJsoncSafe(raw: string): unknown {
  const noBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLineComments = noBlockComments
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/(?!.*["']).*$/, '$1'))
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

/** jsdocOn 批量检查：命中声明正则的导出行必须有前置 JSDoc（上一非空行以块注释结束符结尾） */
function checkRequiredJsdoc(
  rule: SopRule,
  item: RequiredContentInstruction['items'][number],
  context: RuleContext,
): Violation[] {
  const violations: Violation[] = [];
  const patterns = item.jsdocOn ?? [];
  const compiled = patterns
    .filter((p) => isSafeRegexPattern(p))
    .map((p) => {
      try {
        return new RegExp(p);
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  if (compiled.length === 0) return violations;

  const files = resolveFiles(context, item.fileExts);
  for (const filePath of files) {
    const relativePath = relative(context.repoRoot, filePath);
    if (matchesExcludePatterns(relativePath, item.excludePatterns)) continue;
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!compiled.some((re) => re.test(lines[i]))) continue;

      if (!hasPrecedingJsdoc(lines, i)) {
        violations.push(
          makeRequiredViolation(
            rule,
            relativePath,
            i + 1,
            `导出声明缺少 JSDoc 注释: ${lines[i].trim().slice(0, 60)}`,
            '为导出的接口/类型补充 /** ... */ 文档注释',
          ),
        );
      }
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

function makeRequiredViolation(
  rule: SopRule,
  file: string,
  line: number,
  message: string,
  suggestion: string,
): Violation {
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

// ─── 内联评估：layer-boundary ──────────────────────────

type LayerConfig = { name: string; allowedDeps: string[] };

export async function evalLayerBoundary(
  rule: SopRule,
  instr: LayerBoundaryInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context, ['.ts', '.tsx', '.js', '.jsx']);
  const layerMap = buildLayerMap(instr.layers);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    violations.push(...scanFileLayerBoundaries({ content, relativePath, rule, instr, layerMap }));
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message:
      violations.length > 0 ? `发现 ${violations.length} 处架构边界违规` : '架构边界检查通过',
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

function buildLayerMap(layers: LayerBoundaryInstruction['layers']): Map<string, LayerConfig> {
  const layerMap = new Map<string, LayerConfig>();
  for (const layer of layers) {
    layerMap.set(layer.name, { name: layer.name, allowedDeps: layer.allowedDependencies });
  }
  return layerMap;
}

function scanFileLayerBoundaries({
  content,
  relativePath,
  rule,
  instr,
  layerMap,
}: {
  content: string;
  relativePath: string;
  rule: SopRule;
  instr: LayerBoundaryInstruction;
  layerMap: Map<string, LayerConfig>;
}): Violation[] {
  const fileLayer = detectLayer(relativePath, instr.layers);
  if (!fileLayer) return [];
  const violations: Violation[] = [];
  const importRegex =
    /(?:import\s+(?:[\w*{},\s]+\s+from\s+)?['"])([^'"]+)(?:['"])|(?:require\s*\(\s*['"])([^'"]+)(?:['"]\s*\))/g;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    importRegex.lastIndex = 0;
    const m = importRegex.exec(lines[i]);
    if (!m) continue;
    const imported = (m[1] || m[2] || '').split('/')[0];
    const targetLayer = detectLayerByName(imported, instr.layers);
    if (targetLayer && !layerMap.get(fileLayer)?.allowedDeps.includes(targetLayer)) {
      violations.push({
        id: randomUUID(),
        ruleId: rule.id,
        severity: rule.severity,
        file: relativePath,
        line: i + 1,
        message: `层违规: "${fileLayer}" 不允许依赖 "${targetLayer}" (导入: ${imported})`,
        suggestion: `${fileLayer} 层只能依赖: ${(layerMap.get(fileLayer)?.allowedDeps ?? []).join(', ')}`,
      });
    }
  }
  return violations;
}
