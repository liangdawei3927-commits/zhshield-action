// ─── 数据库行类型 ─────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  added_at: string;
  updated_at: string;
}

export interface ScoreRow {
  id: number;
  project_id: string;
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: string;
  trend: 'improving' | 'stable' | 'declining';
  created_at: string;
}

export interface ScanningResultRow {
  id: number;
  project_id: string;
  source: string;
  passed: number;
  summary: string;
  report: string | null;
  created_at: string;
}

export interface RuleRow {
  id: string;
  rule_id: string;
  state: 'active' | 'disabled' | 'deprecated' | 'experimental';
  severity: string | null;
  weight: number;
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
}

export interface ExperienceRow {
  id: string;
  project_id: string;
  rule_id: string;
  type: 'true-positive' | 'false-positive' | 'suggestion' | 'custom';
  detail: string | null;
  source: string | null;
  created_at: string;
}

// ─── 查询参数类型 ─────────────────────────────────────────

export interface CreateProjectParams {
  id: string;
  name: string;
  path: string;
}

export interface SaveScoreParams {
  projectId: string;
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: string;
  trend: 'improving' | 'stable' | 'declining';
}

export interface SaveScanResultParams {
  projectId: string;
  source: string;
  passed: boolean;
  summary: string;
  report?: string;
}

export interface UpsertRuleParams {
  ruleId: string;
  state?: 'active' | 'disabled' | 'deprecated' | 'experimental';
  severity?: string;
  weight?: number;
  reason?: string;
  changedBy?: string;
}

// ─── Sentinel Events ───────────────────────────────────────

export interface SentinelEventRow {
  id: string;
  project_id: string;
  timestamp: string;
  dedupe_key: string;
  title: string;
  service: string;
  module: string;
  severity: 'p1' | 'p2' | 'p3';
  status: string;
  validation: string;   // JSON
  context: string;      // JSON
  history: string;      // JSON
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSentinelEventParams {
  id: string;
  projectId: string;
  timestamp: Date;
  dedupeKey: string;
  title: string;
  service: string;
  module: string;
  severity: 'p1' | 'p2' | 'p3';
  status: string;
  validation: string;
  context: string;
  history: string;
  occurrenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

export interface UpdateSentinelEventParams {
  id: string;
  status?: string;
  validation?: string;
  history?: string;
  occurrenceCount?: number;
  lastSeen?: Date;
}

export interface ListSentinelEventsFilter {
  projectId?: string;
  status?: string;
  severity?: 'p1' | 'p2' | 'p3';
  limit?: number;
  offset?: number;
}

export interface SaveExperienceParams {
  id: string;
  projectId: string;
  ruleId: string;
  type: 'true-positive' | 'false-positive' | 'suggestion' | 'custom';
  detail?: string;
  source?: string;
}

// ─── Debt Actions & Snapshots ─────────────────────────────

export type DebtActionStatus = 'pending' | 'planned' | 'in-progress' | 'repaid' | 'dismissed';

export interface DebtActionRow {
  project_id: string;
  action_id: string;
  status: DebtActionStatus;
  module: string;
  category: string;
  issue_ids: string;
  interest_score: number;
  principal_estimate: number;
  roi: number;
  sprint: string | null;
  gate: string | null;
  created_at: string;
  updated_at: string;
}

export interface DebtSnapshotRow {
  id: number;
  project_id: string;
  debt_index: number;
  created_at: string;
}

export interface SaveDebtActionParams {
  projectId: string;
  actionId: string;
  status: DebtActionStatus;
  module: string;
  category: string;
  issueIds: string[];
  interestScore: number;
  principalEstimate: number;
  roi: number;
  sprint?: string | null;
  gate?: string | null;
}

export interface UpdateDebtActionStatusParams {
  projectId: string;
  actionId: string;
  status: DebtActionStatus;
}

export interface SaveDebtSnapshotParams {
  projectId: string;
  debtIndex: number;
}
