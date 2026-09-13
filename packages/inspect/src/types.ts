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
  issues: Issue[];
}

export interface InspectionReport {
  projectId: string;
  timestamp: Date;
  scanType: 'full' | 'incremental' | 'scheduled';
  duration: number;
  score: { overall: number; grade: 'A' | 'B' | 'C' | 'D' };
  issues: Issue[];
  summary: { total: number; error: number; warning: number; info: number };
  adapterResults: AdapterResult[];
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
