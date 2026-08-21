export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory = 'architecture' | 'security' | 'quality' | 'performance' | 'documentation' | 'test' | 'dependency' | 'refactoring';

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

export interface AdapterResult {
  adapterId: string;
  adapterName: string;
  duration: number;
  issueCount: number;
  passed: boolean;
  /** 降级运行标记（ADR #7）：unavailable 覆盖率缺口时为 true，skipped/error 不标记 */
  degraded?: boolean;
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
}

export interface RunContext {
  projectId: string;
  scanType: InspectionReport['scanType'];
}

export interface InspectAdapter {
  id: string;
  name: string;
  run(context: RunContext): Promise<Issue[]>;
}
