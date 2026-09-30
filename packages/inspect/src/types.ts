import type { Issue as SharedIssue } from '@zh/shared';

/** 问题严重级别（跨域单一来源：与 @zh/shared 的 IssueSeverity 同源） */
export type { IssueSeverity } from '@zh/shared';
/** 问题分类维度（跨域单一来源：与 @zh/shared 的 IssueCategory 同源） */
export type { IssueCategory } from '@zh/shared';

/**
 * 单条巡检问题：直接复用 @zh/shared 的 Issue 字段集（含 codeFlows/stack/taxonomies 等
 * SARIF 扩展），仅把 `source` 放宽为 string——本域的 'ai-code-review' 归属标识不在
 * @zh/shared 的 IssueSource 联合内，强行收窄会破坏 AI 深度审查结果的来源透传。
 */
export type Issue = Omit<SharedIssue, 'source'> & { source: string };

/** 适配器执行状态：unavailable/skipped 表示"未检测"（覆盖率缺口），非通过 */
export type AdapterResultStatus = 'passed' | 'failed' | 'error' | 'unavailable' | 'skipped';

/** 单个巡检适配器的执行结果：耗时、问题数、降级/跳过/失败原因与问题列表 */
export interface AdapterResult {
  adapterId: string;
  adapterName: string;
  duration: number;
  issueCount: number;
  passed: boolean;
  /** 降级运行标记（ADR #7）：unavailable 覆盖率缺口时为 true，skipped/error 不标记 */
  degraded?: boolean;
  /** 工具执行状态透传：unavailable/skipped 表示"未检测"（覆盖率缺口），报告层据此显式上报而非视为通过 */
  status?: AdapterResultStatus;
  /**
   * 跳过原因：out-of-scope = 工具不在当前项目画像 scope 内的既定裁剪（不计入覆盖率分母，
   * 报告层不应视为通过率稀释）；degraded = 降级跳过（沿用既有覆盖率缺口语义）。
   */
  skipReason?: 'degraded' | 'out-of-scope';
  /**
   * 适配器返回 skipped 时携带的真实原因（透传 ToolResult.error），如
   * "Semgrep 规则目录不存在、请先同步云脑规则"/"blocked-by-hook"。
   * 报告层据此如实展示，不再臆断为"语言不适用"（P2）。
   */
  skipDetail?: string;
  /**
   * 适配器返回 error 时携带的真实失败原因（透传 ToolResult.error，如
   * "ESLint couldn't find an eslint.config file" / "dependency-cruiser 执行失败: …"）。
   *
   * 与 skipDetail 同源同构、只是分属不同 status：此前只有 skipped 的原因被透传，
   * error 的原因无处落点 → 报告里只剩 `status:'error', issues:[]`，
   * 用户看到"工具执行失败"却无从得知为什么失败。报告层/CLI/桌面端据此如实展示。
   */
  errorDetail?: string;
  issues: Issue[];
}

/** 评分等级；降级时 grade 追加 ` [N工具降级]` 后缀（如 `D [3工具降级]`） */
export type ScoreGrade = 'A' | 'B' | 'C' | 'D';
/** 评分等级展示形态：纯等级，或降级时追加 ` [N工具降级]` 后缀 */
export type ScoreGradeLabel = ScoreGrade | `${ScoreGrade} [${number}工具降级]`;

/** 巡检报告：项目、扫描方式、评分与等级、问题汇总、各适配器结果与建议 */
export interface InspectionReport {
  projectId: string;
  timestamp: Date;
  scanType: 'full' | 'incremental' | 'scheduled';
  duration: number;
  score: { overall: number; grade: ScoreGradeLabel };
  issues: Issue[];
  summary: { total: number; error: number; warning: number; info: number };
  adapterResults: AdapterResult[];
  /** 非预期降级数（工具不可用/引擎缺失导致"未检测"）：与 ok 判定联动——未检测 ≠ 通过 */
  degraded?: number;
  recommendations: string[];
  /** 基线豁免命中数（无基线/未启用时为 0） */
  suppressedCount?: number;
}

/** 单次巡检运行上下文：项目、扫描方式与项目画像（用于工具 scope 裁剪） */
export interface RunContext {
  projectId: string;
  scanType: InspectionReport['scanType'];
  /** 当前项目画像（language/framework）投影；缺省 = 不按画像裁剪（全量工具） */
  projectFeature?: { framework?: string; language?: string; features?: string[] };
}

/** 巡检适配器契约：适配器 id/名称 + 依据运行上下文产出问题列表的 run 方法 */
export interface InspectAdapter {
  id: string;
  name: string;
  run(context: RunContext): Promise<Issue[]>;
}
