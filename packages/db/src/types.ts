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
  validation: string; // JSON
  context: string; // JSON
  history: string; // JSON
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

export interface SaveDebtActionParams {
  projectId: string;
  actionId: string;
  status: 'pending' | 'planned' | 'in-progress' | 'repaid' | 'dismissed';
  module: string;
  category: string;
  issueIds: string[];
  interestScore: number;
  principalEstimate: number;
  roi: number;
  sprint?: string;
  gate?: string;
}

export interface DebtActionRow {
  project_id: string;
  action_id: string;
  status: 'pending' | 'planned' | 'in-progress' | 'repaid' | 'dismissed';
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

export interface UpdateDebtActionStatusParams {
  projectId: string;
  actionId: string;
  status: SaveDebtActionParams['status'];
}

export interface SaveDebtSnapshotParams {
  projectId: string;
  debtIndex: number;
}

export interface DebtSnapshotRow {
  id: number;
  project_id: string;
  debt_index: number;
  created_at: string;
}

// ─── M3 轻量 Org 多租户（迁移 009）────────────────────────

export interface OrgRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

export interface OrgMemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

export interface RuleScopeRow {
  id: string;
  rule_id: string;
  org_id: string | null;
  version: string;
  enabled: 0 | 1;
  content_sha: string | null;
  source: 'manual' | 'calibrated';
  published_at: string;
}

export interface ProjectFeatureRow {
  id: string;
  project_id: string;
  framework: string | null;
  language: string | null;
  features_json: string;
  schema_version: number;
  updated_at: string;
}

export interface CreateOrgParams {
  id: string;
  name: string;
  ownerUserId: string;
}

export interface AddOrgMemberParams {
  id: string;
  orgId: string;
  userId: string;
  role: OrgMemberRow['role'];
}

export interface UpsertRuleScopeParams {
  id: string;
  ruleId: string;
  /** null = 平台默认（全局兜底） */
  orgId: string | null;
  version: string;
  enabled: boolean;
  contentSha: string | null;
  source?: RuleScopeRow['source'];
}

export interface SaveProjectFeaturesParams {
  id: string;
  projectId: string;
  framework?: string | null;
  language?: string | null;
  features: string[];
  schemaVersion?: number;
}
