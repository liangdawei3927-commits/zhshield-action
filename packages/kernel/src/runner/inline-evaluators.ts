import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { GuardEngineLike } from './evaluator-host';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
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
  detectLayer,
  detectLayerByName,
} from './scan-utils';

// ─── 内联评估：pattern-scan ────────────────────────────

export async function evalPatternScan(
  rule: SopRule,
  instr: PatternScanInstruction,
  context: RuleContext,
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context, instr.fileExts);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    violations.push(...scanPatternsInFile(content, relativePath, rule, instr.patterns, locale));
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message: violations.length > 0
      ? translate('engine.kernel.runner.patternMatchesFound', locale ?? DEFAULT_LANGUAGE, {
          count: violations.length,
          ruleId: rule.id,
        })
      : undefined,
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

// ─── 内联评估：forbidden ───────────────────────────────

export async function evalForbidden(
  rule: SopRule,
  instr: ForbiddenPatternInstruction,
  context: RuleContext,
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    violations.push(...scanForbiddenInFile(content, relativePath, rule, instr.patterns, locale));
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message: violations.length > 0
      ? translate('engine.kernel.runner.forbiddenPatternsFound', locale ?? DEFAULT_LANGUAGE, {
          count: violations.length,
          ruleId: rule.id,
        })
      : undefined,
    durationMs: 0,
    targetEngine: 'inspect',
    timestamp: new Date(),
  };
}

// ─── 内联评估：threshold ───────────────────────────────

export async function evalThreshold(
  rule: SopRule,
  instr: ThresholdInstruction,
  context: RuleContext,
  guardEngine?: GuardEngineLike,
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const summary = buildThresholdSummary(instr, locale);
  await tryQueryThreshold(guardEngine, rule, context);

  return {
    rule,
    status: 'passed',
    message: translate('engine.kernel.runner.thresholdRule', locale ?? DEFAULT_LANGUAGE, { summary }),
    durationMs: 0,
    targetEngine: 'guard',
    timestamp: new Date(),
  };
}

function buildThresholdSummary(instr: ThresholdInstruction, locale?: LanguageCode): string {
  const thresholdKeys = Object.keys(instr.thresholds);
  return thresholdKeys.length > 0
    ? translate('engine.kernel.runner.thresholdList', locale ?? DEFAULT_LANGUAGE, {
        entries: thresholdKeys.map((k) => `${k}=${instr.thresholds[k]}`).join(', '),
      })
    : translate('engine.kernel.runner.thresholdRaw', locale ?? DEFAULT_LANGUAGE, {
        unit: instr.unit ?? '',
        thresholds: JSON.stringify(instr.thresholds),
      });
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
  locale?: LanguageCode,
): Promise<RuleEvaluation> {
  const files = resolveFiles(context, ['.ts', '.tsx', '.js', '.jsx']);
  const layerMap = buildLayerMap(instr.layers);
  const violations: Violation[] = [];

  for (const filePath of files) {
    const content = readFileSafe(filePath);
    if (content === null) continue;

    const relativePath = relative(context.repoRoot, filePath);
    violations.push(...scanFileLayerBoundaries({ content, relativePath, rule, instr, layerMap }, locale));
  }

  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [...new Set(violations.map((v) => v.file))],
    message: violations.length > 0
      ? translate('engine.kernel.runner.layerBoundaryViolations', locale ?? DEFAULT_LANGUAGE, {
          count: violations.length,
        })
      : translate('engine.kernel.runner.layerBoundaryPassed', locale ?? DEFAULT_LANGUAGE),
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
}, locale?: LanguageCode): Violation[] {
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
        message: translate('engine.kernel.runner.layerViolationMessage', locale ?? DEFAULT_LANGUAGE, {
          fileLayer,
          targetLayer,
          imported,
        }),
        suggestion: translate('engine.kernel.runner.layerAllowedDeps', locale ?? DEFAULT_LANGUAGE, {
          fileLayer,
          deps: (layerMap.get(fileLayer)?.allowedDeps ?? []).join(', '),
        }),
      });
    }
  }
  return violations;
}
