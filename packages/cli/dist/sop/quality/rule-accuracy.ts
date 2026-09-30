// ─────────────────────────────────────────────────────────────
// 规则准确率评估（2026-09-22 建立）
//
// 定位：SOP 规则的「误报 / 漏报」量化门禁。
// 与 `fingerprint/src/accuracy.ts` 同源（同一套 precision / recall 口径），
// 但评估对象不同 ——
//   accuracy.ts      → 画像探测器（断言粒度：文件级）
//   rule-accuracy.ts → SOP 规则（断言粒度：规则 + 文件 [+ 行]）
//
// 设计动机：本项目「Gate 判定 = 单测全绿 + 条款打勾」，而单测天然是逐段 mock 的
// 孤岛，照不到「规则报得对不对」。已实证后果：规则 `status: active` 却只匹配函数名、
// 漏排配置文件，产出数百条误报且无人校准（无 fixture 回放、无误报率阈值）。
// 本模块把这件事变成可计算的判据：规则升 active / 改动后，必须过 golden 断言回放，
// precision / recall 达标才放行。
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── 阈值常量 ───

/** 规则 precision 下限（沿用架构文档 §10.2 的探测器口径） */
export const RULE_PRECISION_THRESHOLD = 0.95;
/** 规则 recall 下限 */
export const RULE_RECALL_THRESHOLD = 0.9;
/** 行号匹配容差（规则上报行常与违规行差 1-2 行） */
export const DEFAULT_LINE_TOLERANCE = 2;

// ─── 类型定义 ───

/**
 * golden 断言：声明「这条规则应不应该在何处命中」。
 * 不含 ruleId —— 所属规则由外层 RuleGoldenFile 声明（断言与 finding 在单规则内比对）。
 */
export interface RuleGoldenAssertion {
  /** 相对 fixture 根的文件路径 */
  readonly file: string;
  /** 期望命中的行号；缺省 = 只校验文件级 */
  readonly line?: number;
  /** violation = 该处应被报出；clean = 该处是合法代码，不得报 */
  readonly expect: 'violation' | 'clean';
}

/** 规则实际产出的命中（由 Issue[] 投影而来） */
export interface RuleFinding {
  readonly ruleId: string;
  readonly file: string;
  readonly line?: number;
}

/** golden 文件（一规则一文件：`<dir>/<ruleId>.json`） */
export interface RuleGoldenFile {
  readonly ruleId: string;
  /** 该规则的阈值覆盖（缺省用全局常量）—— 高风险规则可要求更严 */
  readonly thresholds?: {
    readonly precision?: number;
    readonly recall?: number;
  };
  /** 行号容差覆盖 */
  readonly lineTolerance?: number;
  readonly assertions: readonly RuleGoldenAssertion[];
}

/**
 * 单条规则的准确率评估结果（golden 断言 vs 规则实际产出）。
 * precision / recall 由 TP/FP/FN 推出，passes 为是否达到该规则自身阈值。
 */
export interface RuleEvaluation {
  readonly ruleId: string;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  /** findings 中未在 golden 标注过的条数（严格模式下计入 FP） */
  readonly unlabeledFindings: number;
  readonly precision: number;
  readonly recall: number;
  readonly passes: boolean;
}

/**
 * 规则准确率报告：逐条规则的评估明细 + 整体精确率/召回率。
 * passesThresholds 为门禁结论，要求每条规则都达标（见成员说明）。
 */
export interface RuleAccuracyReport {
  readonly evaluations: readonly RuleEvaluation[];
  readonly overallPrecision: number;
  readonly overallRecall: number;
  /**
   * 门禁结论：**每一条**规则都必须达标（every，不是宏平均）。
   * 用宏平均会让一条烂规则被其他好规则拉平而漏检。
   */
  readonly passesThresholds: boolean;
}

/** 规则准确率评估选项：仅 strictUnlabeled 一项，缺省为严格模式 */
export interface EvaluateRuleAccuracyOptions {
  /** 缺省 true：未标注的 finding 计入 FP（门禁应抓「未经确认的输出」） */
  readonly strictUnlabeled?: boolean;
}

// ─── 公共 API ───

/**
 * 评估规则准确率：golden 断言 vs 规则实际产出。
 *
 * 计数口径（与 accuracy.ts 同构）：
 *   TP = 命中某条 violation 断言的 finding
 *   FN = 未被任何 finding 覆盖的 violation 断言
 *   FP = 未被任何 violation 断言认领的 finding（命中 clean 断言 = 明确误报）
 */
export function evaluateRuleAccuracy(
  golden: readonly RuleGoldenFile[],
  findings: readonly RuleFinding[],
  options: EvaluateRuleAccuracyOptions = {},
): RuleAccuracyReport {
  const strictUnlabeled = options.strictUnlabeled ?? true;
  const evaluations = golden.map((file) => evaluateRule(file, findings, strictUnlabeled));
  const { precision, recall } = macroAverage(evaluations);
  return {
    evaluations,
    overallPrecision: precision,
    overallRecall: recall,
    passesThresholds: evaluations.every((e) => e.passes),
  };
}

/**
 * 把规则产出的违规（Issue / Violation）投影为评估用 finding。
 * 传入 baseDir 时把绝对路径归一化为相对路径，便于与 golden 断言（相对路径）比对。
 */
export function toRuleFindings(
  issues: ReadonlyArray<{
    readonly ruleId: string;
    readonly file: string;
    readonly line?: number;
  }>,
  baseDir?: string,
): RuleFinding[] {
  return issues.map((i) => ({
    ruleId: i.ruleId,
    file: baseDir && path.isAbsolute(i.file) ? path.relative(baseDir, i.file) : i.file,
    line: i.line,
  }));
}

/**
 * 从目录加载 golden 文件（布局：`<dir>/<ruleId>.json`）
 * 非纯函数（读文件系统），但在模块内可测
 */
// eslint-disable-next-line perf/perf-walk-requires-ignore -- golden 目录单层 readdir（非递归），node_modules 无关，规则误报
export function loadRuleGoldenDir(dirPath: string): RuleGoldenFile[] {
  if (!fs.existsSync(dirPath)) return [];
  const out: RuleGoldenFile[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dirPath, entry.name), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRuleGoldenFile(raw)) continue;
    out.push(raw);
  }
  return out;
}

/** 生成可读报告（测试失败时打印，便于定位是漏报还是误报） */
export function formatRuleAccuracyReport(report: RuleAccuracyReport): string {
  const lines = [
    `规则准确率门禁：precision=${report.overallPrecision.toFixed(3)} ` +
      `recall=${report.overallRecall.toFixed(3)} → ${report.passesThresholds ? 'PASS' : 'FAIL'}`,
  ];
  for (const e of report.evaluations) {
    const unlabeled = e.unlabeledFindings > 0 ? ` 未标注=${e.unlabeledFindings}` : '';
    lines.push(
      `  ${e.passes ? '✓' : '✗'} ${e.ruleId} ` +
        `P=${e.precision.toFixed(3)} R=${e.recall.toFixed(3)} ` +
        `TP=${e.truePositives} FP=${e.falsePositives} FN=${e.falseNegatives}${unlabeled}`,
    );
  }
  return lines.join('\n');
}

// ─── 内部实现 ───

function evaluateRule(
  file: RuleGoldenFile,
  allFindings: readonly RuleFinding[],
  strictUnlabeled: boolean,
): RuleEvaluation {
  const findings = allFindings.filter((f) => f.ruleId === file.ruleId);
  const violations = file.assertions.filter((a) => a.expect === 'violation');
  const cleans = file.assertions.filter((a) => a.expect === 'clean');
  const tolerance = file.lineTolerance ?? DEFAULT_LINE_TOLERANCE;

  const claimedAssertion = new Set<number>();
  const claimedFinding = new Set<number>();

  // TP：finding 认领某条 violation 断言（一条断言只能被认领一次）
  findings.forEach((finding, fi) => {
    for (let ai = 0; ai < violations.length; ai++) {
      if (claimedAssertion.has(ai)) continue;
      if (matches(finding, violations[ai], tolerance)) {
        claimedAssertion.add(ai);
        claimedFinding.add(fi);
        break;
      }
    }
  });

  // FP：未被任何 violation 断言认领的 finding
  let explicitFalsePositives = 0;
  let unlabeled = 0;
  findings.forEach((finding, fi) => {
    if (claimedFinding.has(fi)) return;
    if (cleans.some((c) => matches(finding, c, tolerance))) explicitFalsePositives++;
    else unlabeled++;
  });

  const truePositives = claimedAssertion.size;
  const falseNegatives = violations.length - truePositives;
  const falsePositives = explicitFalsePositives + (strictUnlabeled ? unlabeled : 0);

  // 无输出 ⇒ 无 FP，precision 记 1（漏报由 recall 暴露）；无 violation 断言 ⇒ recall 记 1
  const precision =
    truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 1;
  const recall = violations.length > 0 ? truePositives / violations.length : 1;

  const precisionThreshold = file.thresholds?.precision ?? RULE_PRECISION_THRESHOLD;
  const recallThreshold = file.thresholds?.recall ?? RULE_RECALL_THRESHOLD;

  return {
    ruleId: file.ruleId,
    truePositives,
    falsePositives,
    falseNegatives,
    unlabeledFindings: unlabeled,
    precision,
    recall,
    passes: precision >= precisionThreshold && recall >= recallThreshold,
  };
}

/** finding 是否匹配断言（文件路径归一化后比对；断言给了行号才校验行） */
function matches(finding: RuleFinding, assertion: RuleGoldenAssertion, tolerance: number): boolean {
  if (normalizePath(finding.file) !== normalizePath(assertion.file)) return false;
  if (assertion.line === undefined) return true;
  if (finding.line === undefined) return false;
  return Math.abs(finding.line - assertion.line) <= tolerance;
}

const LEADING_DOT_SLASH_RE = /^\.\//;
const TRAILING_SLASH_RE = /\/+$/;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(LEADING_DOT_SLASH_RE, '').replace(TRAILING_SLASH_RE, '');
}

function macroAverage(evaluations: readonly RuleEvaluation[]): {
  precision: number;
  recall: number;
} {
  if (evaluations.length === 0) return { precision: 1, recall: 1 };
  const sum = evaluations.reduce(
    (acc, e) => ({ precision: acc.precision + e.precision, recall: acc.recall + e.recall }),
    { precision: 0, recall: 0 },
  );
  return {
    precision: sum.precision / evaluations.length,
    recall: sum.recall / evaluations.length,
  };
}

/** 类型守卫：验证 unknown 是否为合法 RuleGoldenFile */
function isRuleGoldenFile(value: unknown): value is RuleGoldenFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ruleId?: unknown; assertions?: unknown };
  return typeof v.ruleId === 'string' && Array.isArray(v.assertions);
}
