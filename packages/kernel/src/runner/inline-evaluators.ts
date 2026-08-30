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
  LayerBoundaryInstruction,
} from '../sop/_meta/rule-evaluation';
import {
  resolveFiles,
  readFileSafe,
  scanPatternsInFile,
  scanForbiddenInFile,
  matchesExcludePatterns,
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
    message: violations.length > 0
      ? `发现 ${violations.length} 处匹配 (${rule.id})`
      : undefined,
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
function isRuleWhitelisted(entries: WhitelistRuleEntry[], ruleId: string, filePath: string): boolean {
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
    message: violations.length > 0
      ? `发现 ${violations.length} 处禁止模式 (${rule.id})`
      : undefined,
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
    message: violations.length > 0
      ? `发现 ${violations.length} 处架构边界违规`
      : '架构边界检查通过',
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
  const importRegex = /(?:import\s+(?:[\w*{},\s]+\s+from\s+)?['"])([^'"]+)(?:['"])|(?:require\s*\(\s*['"])([^'"]+)(?:['"]\s*\))/g;
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
