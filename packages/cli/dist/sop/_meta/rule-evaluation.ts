import type { SopRule, Severity } from './sop-types';
import { severityRank } from './adaptive-severity';
import type { IssueCategory } from '@zh/shared';

// ─── 评估状态 ──────────────────────────────────────────

export type EvaluationStatus = 'passed' | 'failed' | 'error' | 'skipped';

// ─── 一条规则的单次评估结果 ─────────────────────────────

export interface RuleEvaluation {
  /** 关联的规则 */
  rule: SopRule;

  /** 评估状态 */
  status: EvaluationStatus;

  /** 失败/错误的详细信息 */
  message?: string;

  /** 涉及的文件列表 */
  files?: string[];

  /** 违规详情（每一条具体问题） */
  violations?: Violation[];

  /** 执行耗时 (ms) */
  durationMs: number;

  /** 目标引擎 */
  targetEngine: 'guard' | 'inspect';

  /** 时间戳 */
  timestamp: Date;

  /** 阻断判定（F1-4）：failed 且有效严重级达到规则声明的 blockingThreshold；未声明阈值的规则保持旧行为（failed 即阻断）。
   *  可选字段：由 SopRuleEngine.evaluateAll 统一附加；外部/存量评估缺省时消费方按 status==='failed' 回退。 */
  blocking?: boolean;
}

// ─── 单条违规 ──────────────────────────────────────────

export interface Violation {
  /** 违规 ID */
  id: string;

  /** 规则 ID */
  ruleId: string;

  /** 严重级别 */
  severity: Severity;

  /** 文件路径 */
  file: string;

  /** 行号 */
  line?: number;

  /** 列号 */
  column?: number;

  /** 违规描述 */
  message: string;

  /** 修复建议 */
  suggestion?: string;

  /** 原始匹配内容 */
  match?: string;

  /** issue 分类（由适配器产出，透传至报告层） */
  category?: IssueCategory;
}

// ─── 引擎报告 ──────────────────────────────────────────

export interface RuleEngineReport {
  /** 总评估数 */
  total: number;

  /** 通过数 */
  passed: number;

  /** 失败数 */
  failed: number;

  /** 出错数 */
  errors: number;

  /** 跳过数 */
  skipped: number;

  /** 是否通过（无 blocking 级别失败） */
  ok: boolean;

  /** 阻断评估数（F1-4） */
  blockingCount?: number;

  /** 各规则的详细评估 */
  evaluations: RuleEvaluation[];

  /** 执行总耗时 (ms) */
  durationMs: number;

  /** 时间戳 */
  timestamp: Date;
}

// ─── 阻断判定（F1-4）────────────────────────────────────

/**
 * computeBlocking — 纯函数：单次评估是否构成「阻断」。
 *
 * - 非 failed（passed / skipped / error）一律不阻断；
 * - 规则未声明 blockingThreshold → 保持旧行为：failed 即阻断；
 * - 声明了阈值 → 有效严重级秩 >= 阈值秩才阻断（severityRank 单一事实源；未知值秩 -1 永不达标）。
 *
 * 结果仅作为附加元数据写入 RuleEvaluation.blocking，
 * 不参与 RuleEngineReport.ok 的计算（ok 保持纯状态驱动：failed===0 && errors===0）。
 */
export function computeBlocking(
  status: EvaluationStatus,
  effectiveSeverity: Severity,
  threshold?: Severity,
): boolean {
  if (status !== 'failed') return false;
  if (threshold === undefined) return true;
  return severityRank(effectiveSeverity) >= severityRank(threshold);
}

// ─── 规则内容解释器输出 ─────────────────────────────────

/**
 * ContentInstruction — 规则内容经过解释后的可执行指令
 *
 * 现有类型：
 * - patterns[] → 正则匹配扫描
 * - checks[] → 规则检查（如 ESLint 规则名单）
 * - thresholds → 阈值比较（覆盖率、复杂度）
 * - forbidden → 禁止模式检测
 * - layers → 架构层级边界
 * - scanners[] → 外置工具链扫描
 * - presets[] → 配置预设
 * - tool-dispatch → 通过模板中 check.tool 指定的外部工具执行（新增）
 */
export type ContentInstruction =
  | PatternScanInstruction
  | CheckListInstruction
  | ThresholdInstruction
  | ForbiddenPatternInstruction
  | LayerBoundaryInstruction
  | ScannerDispatchInstruction
  | PresetInstruction
  | ToolDispatchInstruction;

export interface PatternScanInstruction {
  type: 'pattern-scan';
  patterns: string[];
  /** 扫描文件扩展名过滤 */
  fileExts?: string[];
}

export interface CheckListInstruction {
  type: 'check-list';
  checks: Array<{ rule: string; level: string }>;
}

export interface ThresholdInstruction {
  type: 'threshold';
  thresholds: Record<string, number>;
  unit?: string;
  scope?: string;
}

export interface ForbiddenPatternInstruction {
  type: 'forbidden';
  patterns: string[];
  /** 扫描文件扩展名过滤（与 PatternScanInstruction.fileExts 对齐） */
  fileExts?: string[];
  /** 排除模式（相对路径 glob，支持 ** 跨目录与 * 单段通配），如测试文件与构建产物 */
  excludePatterns?: string[];
}

export interface LayerBoundaryInstruction {
  type: 'layer-boundary';
  layers: Array<{ name: string; allowedDependencies: string[] }>;
}

export interface ScannerDispatchInstruction {
  type: 'scanner-dispatch';
  scanners: string[];
  schedule?: string;
}

export interface PresetInstruction {
  type: 'preset';
  presets: string[];
}

/**
 * ToolDispatchInstruction — 调用外部工具的指令
 *
 * 由 ContentInterpreter 在检测到 SopRule.content 中包含
 * check.tool 字段时生成（sop-templates 嵌套格式）。
 * SopRuleEngine 收到此指令后将按 tool 名称路由到对应的 ToolAdapter。
 */
export interface ToolDispatchInstruction {
  type: 'tool-dispatch';
  /** 工具名称，如 "eslint" | "semgrep" | "trivy" | "gitleaks" */
  tool: string;
  /** 工具配置（模板中的 check.toolConfig） */
  toolConfig: Record<string, unknown>;
  /** 条件过滤 */
  conditions?: {
    languages?: string[];
    filePatterns?: string[];
    excludePatterns?: string[];
  };
  /** 裁决参数 */
  judgment?: {
    passCondition?: string;
    blocking?: string;
    priority?: string;
    maxIssues?: number;
  };
  /** 修复建议 */
  fix?: {
    autoFixAvailable?: boolean;
    suggestionTemplate?: string;
    resources?: string[];
  };
}
