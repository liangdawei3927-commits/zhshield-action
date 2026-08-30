// 准确率评估模块（架构文档 §10.2）
// 纯函数评估探测器 precision/recall，loadGoldenDir 读 golden.json（node:fs）

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 类型定义 ───

export interface GoldenAssertion {
  path: string;
  language?: string;
  framework?: string;
  productForm?: string;
}

export interface DetectorEvaluation {
  detectorId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
}

export interface AccuracyReport {
  evaluations: DetectorEvaluation[];
  overallPrecision: number;
  overallRecall: number;
  passesThresholds: boolean;
}

// ─── 阈值常量（架构文档 §10.2） ───

const LANGUAGE_PRECISION_THRESHOLD = 0.95;
const LANGUAGE_RECALL_THRESHOLD = 0.9;
const FORM_PRECISION_THRESHOLD = 0.8;

// ─── 内部辅助 ───

/** 检测项是否匹配断言（文件路径 + 可选字段匹配） */
function matchesAssertion(
  det: { readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string },
  assertion: GoldenAssertion,
): boolean {
  if (det.file !== assertion.path) return false;
  if (assertion.language !== undefined && det.language !== assertion.language) return false;
  if (assertion.framework !== undefined && det.framework !== assertion.framework) return false;
  if (assertion.productForm !== undefined && det.productForm !== assertion.productForm) return false;
  return true;
}

/** 按 detectorId 分类：含 "form" 为形态探测器，其余为语言探测器 */
function isFormDetector(detectorId: string): boolean {
  return detectorId.includes('form');
}

/** 单个探测器的 precision/recall 计算 */
function evaluateDetector(
  detectorId: string,
  assertions: readonly GoldenAssertion[],
  detections: ReadonlyArray<{ readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>,
): DetectorEvaluation {
  const { truePositives, matchedCount } = countTruePositives(detections, assertions);
  const falsePositives = detections.length - truePositives;
  const falseNegatives = assertions.length - matchedCount;
  const { precision, recall } = computeRates(truePositives, detections.length, assertions.length);
  return { detectorId, truePositives, falsePositives, falseNegatives, precision, recall };
}

function countTruePositives(
  detections: ReadonlyArray<{ readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>,
  assertions: readonly GoldenAssertion[],
): { truePositives: number; matchedCount: number } {
  const matchedAssertionIndices = new Set<number>();
  let truePositives = 0;

  for (const det of detections) {
    for (let i = 0; i < assertions.length; i++) {
      if (!matchedAssertionIndices.has(i) && matchesAssertion(det, assertions[i])) {
        matchedAssertionIndices.add(i);
        truePositives++;
        break;
      }
    }
  }

  return { truePositives, matchedCount: matchedAssertionIndices.size };
}

function computeRates(
  truePositives: number,
  totalDetections: number,
  totalAssertions: number,
): { precision: number; recall: number } {
  const precision = totalDetections > 0 ? truePositives / totalDetections : 0;
  const recall = totalAssertions > 0 ? truePositives / totalAssertions : 0;
  return { precision, recall };
}

/** 计算评估列表的宏平均值 */
function macroAverage(evaluations: readonly DetectorEvaluation[]): { precision: number; recall: number } {
  if (evaluations.length === 0) return { precision: 0, recall: 0 };
  const sum = evaluations.reduce(
    (acc, e) => ({ precision: acc.precision + e.precision, recall: acc.recall + e.recall }),
    { precision: 0, recall: 0 },
  );
  return { precision: sum.precision / evaluations.length, recall: sum.recall / evaluations.length };
}

// ─── 公共 API ───

/**
 * 评估探测器准确率（架构文档 §10.2）
 * 按 detectorId 分组计算每个探测器的 precision/recall，overall 为宏平均。
 * passesThresholds = 语言 precision≥0.95 且 recall≥0.9 且 形态 precision≥0.8
 */
export function evaluateAccuracy(
  assertions: readonly GoldenAssertion[],
  detected: ReadonlyArray<{ readonly file: string; readonly detectorId: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>,
): AccuracyReport {
  const grouped = groupByDetector(detected);
  const evaluations = evaluateAll(grouped, assertions);
  const { precision: overallPrecision, recall: overallRecall } = macroAverage(evaluations);
  const passesThresholds = computeThresholds(evaluations);
  return { evaluations, overallPrecision, overallRecall, passesThresholds };
}

function groupByDetector(
  detected: ReadonlyArray<{ readonly file: string; readonly detectorId: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>,
): Map<string, Array<{ readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>> {
  const grouped = new Map<string, Array<{ readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>>();
  for (const det of detected) {
    const group = grouped.get(det.detectorId);
    if (group) {
      group.push(det);
    } else {
      grouped.set(det.detectorId, [det]);
    }
  }
  return grouped;
}

function evaluateAll(
  grouped: Map<string, Array<{ readonly file: string; readonly language?: string; readonly framework?: string; readonly productForm?: string }>>,
  assertions: readonly GoldenAssertion[],
): DetectorEvaluation[] {
  const evaluations: DetectorEvaluation[] = [];
  for (const [detectorId, detections] of grouped) {
    evaluations.push(evaluateDetector(detectorId, assertions, detections));
  }
  return evaluations;
}

function computeThresholds(evaluations: readonly DetectorEvaluation[]): boolean {
  const langEvals = evaluations.filter((e) => !isFormDetector(e.detectorId));
  const formEvals = evaluations.filter((e) => isFormDetector(e.detectorId));
  const langAvg = langEvals.length > 0 ? macroAverage(langEvals) : { precision: 1, recall: 1 };
  const formAvg = formEvals.length > 0 ? macroAverage(formEvals) : { precision: 1, recall: 1 };
  return (
    langAvg.precision >= LANGUAGE_PRECISION_THRESHOLD &&
    langAvg.recall >= LANGUAGE_RECALL_THRESHOLD &&
    formAvg.precision >= FORM_PRECISION_THRESHOLD
  );
}

/**
 * 从目录加载 golden.json 断言列表（fixture 布局：dir/fixture-name/golden.json）
 * 非纯函数（读文件系统），但在模块内可测
 */
export function loadGoldenDir(dirPath: string): GoldenAssertion[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const assertions: GoldenAssertion[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const goldenPath = path.join(dirPath, entry.name, 'golden.json');
    if (!fs.existsSync(goldenPath)) continue;
    const raw: unknown = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!isGoldenAssertion(item)) continue;
      assertions.push(item);
    }
  }

  return assertions;
}

/** 类型守卫：验证 unknown 是否为合法 GoldenAssertion */
function isGoldenAssertion(value: unknown): value is GoldenAssertion {
  return typeof value === 'object' && value !== null && 'path' in value && typeof (value as { path: unknown }).path === 'string';
}
