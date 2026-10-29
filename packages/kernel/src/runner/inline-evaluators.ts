import { randomUUID } from 'node:crypto';

import type { SopRule } from '../sop/_meta/sop-types';
import type { RuleContext } from '../sop/_meta/rule-context';
import { skipEvaluation } from './evaluation-builders';
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

/**
 * 下限型度量单位：数值越高越好（覆盖率、评分）。其余按上限型处理（复杂度、行数、嵌套深度）。
 *
 * threshold 指令没有 direction 字段，方向只能由 unit 约定推断 —— **新增单位必须在此登记**，
 * 否则会按「越大越差」比较，把覆盖率 90% 判成超标。
 */
const LOWER_BOUND_UNITS = new Set(['percent', 'percentage', 'ratio', 'score']);

/**
 * 阈值指令评估。
 *
 * 2026-10-29 前的实现恒返回 `status: 'passed'`，只把阈值拼成一句 message 丢掉 ——
 * 后果是 4 条 active 云端阈值规则（复杂度 / 质量分 / 健康分 / 覆盖率）在报告里
 * 恒显示「通过」，而全仓没有任何代码把阈值与实测值做过比较（`@zh/scoring` 的
 * sop-converters 连 threshold 都不读）。这是「面板显示通过、实际零检查」的典型形态。
 *
 * 现改为三态：有实测值 ⇒ 真比较；缺实测值 ⇒ `skipped + degraded`（计入 aggregate.ok，
 * 不再伪装成通过）；未声明指标 ⇒ 同样判未执行。
 *
 * 实测值入口：`context.extra.metrics`（指标名 → 数值），键名与规则 thresholds 的键一致。
 */
export async function evalThreshold(
  rule: SopRule,
  instr: ThresholdInstruction,
  context: RuleContext,
): Promise<RuleEvaluation> {
  const targetEngine = rule.domain === 'guard' ? 'guard' : 'inspect';
  const required = Object.keys(instr.thresholds);
  const metrics = readMetricBag(context);
  const missing = required.filter((key) => typeof metrics[key] !== 'number');

  // 阈值本身不产生检查结果 —— 宁可不跑，也不跑一半（部分指标缺失时整条判未执行）
  if (required.length === 0 || missing.length > 0) {
    return skipEvaluation(
      rule,
      describeMissingMetrics(instr, required, missing),
      targetEngine,
      true,
    );
  }

  const violations = compareThresholds(rule, instr, metrics);
  return {
    rule,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    files: [],
    message:
      violations.length === 0
        ? `阈值达标: ${buildThresholdSummary(instr, metrics)}`
        : `阈值未达标 ${violations.length} 项: ${buildThresholdSummary(instr, metrics)}`,
    durationMs: 0,
    targetEngine,
    timestamp: new Date(),
  };
}

/** 读取调用方注入的实测值；非数值条目一律忽略，交由 missing 判定 */
function readMetricBag(context: RuleContext): Record<string, number | undefined> {
  const bag = context.extra?.metrics;
  if (typeof bag !== 'object' || bag === null) return {};
  return bag as Record<string, number | undefined>;
}

function isLowerBoundUnit(unit: string | undefined): boolean {
  return unit !== undefined && LOWER_BOUND_UNITS.has(unit.toLowerCase());
}

function compareThresholds(
  rule: SopRule,
  instr: ThresholdInstruction,
  metrics: Record<string, number | undefined>,
): Violation[] {
  const lowerBound = isLowerBoundUnit(instr.unit);
  const suffix = instr.unit ? ` ${instr.unit}` : '';
  const violations: Violation[] = [];
  for (const [metric, limit] of Object.entries(instr.thresholds)) {
    const actual = metrics[metric];
    if (typeof actual !== 'number') continue;
    const breached = lowerBound ? actual < limit : actual > limit;
    if (!breached) continue;
    // 阈值是项目级指标，没有具体文件位置 —— 沿用 check-list 的项目级空路径约定
    violations.push({
      id: randomUUID(),
      ruleId: rule.id,
      severity: rule.severity,
      file: '',
      message: lowerBound
        ? `${metric}=${actual}${suffix} 低于阈值 ${limit}${suffix}`
        : `${metric}=${actual}${suffix} 超过阈值 ${limit}${suffix}`,
      suggestion: lowerBound
        ? `将 ${metric} 提升到 ${limit}${suffix} 以上`
        : `将 ${metric} 降到 ${limit}${suffix} 以内`,
    });
  }
  return violations;
}

function buildThresholdSummary(
  instr: ThresholdInstruction,
  metrics: Record<string, number | undefined>,
): string {
  return Object.entries(instr.thresholds)
    .map(([metric, limit]) => `${metric}=${metrics[metric] ?? '?'}/${limit}`)
    .join(', ');
}

function describeMissingMetrics(
  instr: ThresholdInstruction,
  required: string[],
  missing: string[],
): string {
  if (required.length === 0) {
    return '阈值规则未声明任何可比较指标，未执行任何检查';
  }
  const declared = required.map((key) => `${key}=${instr.thresholds[key]}`).join(', ');
  return (
    `阈值规则缺少度量数据源，未执行任何比较（阈值 ${declared}；缺实测值: ${missing.join(', ')}）。` +
    '阈值本身不产出检查结果，需调用方经 context.extra.metrics 注入实测值后才会比较'
  );
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
