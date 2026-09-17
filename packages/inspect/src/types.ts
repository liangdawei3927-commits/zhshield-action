export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory =
  | 'architecture'
  | 'security'
  | 'quality'
  | 'performance'
  | 'documentation'
  | 'test'
  | 'dependency'
  | 'refactoring';

export interface Issue {
  id: string;
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  file: string;
  line?: number;
  column?: number;
  suggestion?: string;
  autoFixable: boolean;
  source: string;
  fingerprint: string;
}

export type AdapterResultStatus = 'passed' | 'failed' | 'error' | 'unavailable' | 'skipped';

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
export type ScoreGradeLabel = ScoreGrade | `${ScoreGrade} [${number}工具降级]`;

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

export interface RunContext {
  projectId: string;
  scanType: InspectionReport['scanType'];
  /** 当前项目画像（language/framework）投影；缺省 = 不按画像裁剪（全量工具） */
  projectFeature?: { framework?: string; language?: string; features?: string[] };
}

export interface InspectAdapter {
  id: string;
  name: string;
  run(context: RunContext): Promise<Issue[]>;
}
