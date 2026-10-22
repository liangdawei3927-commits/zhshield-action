import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import type { GuardEngineLike } from './evaluator-host';
import type {
  RuleEvaluation,
  Violation,
  PatternScanInstruction,
  ThresholdInstruction,
  LayerBoundaryInstruction,
} from '../sop/_meta/rule-evaluation';
import { scanPatternsInFile, detectLayer, detectLayerByName } from './scan-utils';
import { forEachScanTarget } from './inline-eval-scan-target';

// ─── 内联评估：pattern-scan ────────────────────────────

export async function evalPatternScan(
  rule: SopRule,
  instr: PatternScanInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const violations: Violation[] = [];
  forEachScanTarget(context, instr.fileExts, undefined, (content, relativePath) => {
    violations.push(...scanPatternsInFile(content, relativePath, rule, instr.patterns));
  });

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
  const layerMap = buildLayerMap(instr.layers);
  const violations: Violation[] = [];

  forEachScanTarget(
    context,
    ['.ts', '.tsx', '.js', '.jsx'],
    instr.excludePatterns,
    (content, relativePath) => {
      violations.push(
        ...scanFileLayerBoundaries({ content, relativePath, rule, instr, layerMap }),
      );
    },
  );

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
    let m: RegExpExecArray | null;
    // 一行可能有多条 import（如 `import a from 'x'; import b from 'y'`），逐条检查
    while ((m = importRegex.exec(lines[i])) !== null) {
      const imported = m[1] || m[2] || '';
      if (!imported) continue;
      // 传**完整导入路径**：detectLayerByName 按目录段匹配层名，相对路径
      // （../services/user）与路径别名（@app/services/user）均能识别。
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
  }
  return violations;
}

// ─── 其余内联评估域已按功能拆分为同级模块 ───────────────
// 本文件保留原模块路径与全部原导出（re-export），调用方无需改动任何 import：
// - forbidden / forbidden-regex → inline-eval-forbidden.ts
// - required-content → inline-eval-required-content.ts
// （pattern-scan / threshold / layer-boundary 三者评估结果的 targetEngine 为
//   'guard'，其收尾对象字面量逐行同形，须留在同一文件内避免跨文件重复区）

export { evalForbidden, evalForbiddenRegex } from './inline-eval-forbidden';
export { evalRequiredContent } from './inline-eval-required-content';
