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

// ─── 规则内容仓库（迁移 010，05-规则内容仓库与管理后台.md §二）──────

/** rule_content — 规则本体表（一条规则 = 一行） */
export interface RuleContentRow {
  id: string;
  rule_id: string;
  domain: string;
  action: string;
  source: string;
  name: string;
  description: string | null;
  severity: string;
  status: string; // draft | trial | active | deprecated | disabled
  execution_mode: string;
  tags: string; // JSON 数组
  applicable_engines: string; // JSON 数组
  languages: string; // JSON 数组
  frameworks: string; // JSON 数组
  tool_id: string | null;
  tool_version: string | null;
  content: string; // SopRule 稳定子集的规范化序列化（H1）
  content_sha: string; // computeRuleContentSha(SopRule)（H1）
  version: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

/** rule_content_version — 规则历史快照（发布/回滚） */
export interface RuleContentVersionRow {
  id: string;
  rule_id: string;
  version: string;
  content_sha: string;
  content: string;
  status_at_release: string;
  released_by: string | null;
  released_at: string;
  changes: string | null;
}

/** tool_package — 工具包注册表（当前生效版本） */
export interface ToolPackageRow {
  id: string;
  tool_id: string;
  version: string;
  sha256: string;
  files_json: string; // [{filename, content}]
  languages: string; // JSON 数组
  frameworks: string; // JSON 数组
  status: string; // active | deprecated | disabled
  description: string | null;
  created_by: string | null;
  created_at: string;
}

/** tool_package_version — 工具包历史快照（发布/回滚） */
export interface ToolPackageVersionRow {
  id: string;
  tool_id: string;
  version: string;
  sha256: string;
  files_json: string;
  languages: string;
  frameworks: string;
  released_by: string | null;
  released_at: string;
  changes: string | null;
}

/** content_audit_log — 内容操作审计（谁改了什么） */
export interface ContentAuditLogRow {
  id: string;
  entity_type: 'rule' | 'tool';
  entity_id: string;
  action: string; // create | update | delete | publish | rollback | status_change
  detail: string | null;
  operator: string;
  operated_at: string;
}

/** 创建/更新规则的入参（C4 /admin/rules） */
export interface SaveRuleContentParams {
  id: string;
  ruleId: string;
  domain: string;
  action: string;
  source?: string;
  name: string;
  description?: string | null;
  severity: string;
  status?: string;
  executionMode?: string;
  tags?: string[];
  applicableEngines?: string[];
  languages?: string[];
  frameworks?: string[];
  toolId?: string | null;
  toolVersion?: string | null;
  content: string;
  contentSha: string;
  version: string;
  createdBy?: string | null;
  updatedBy?: string | null;
}

/** 保存规则历史快照的入参（publish 时写入） */
export interface SaveRuleContentVersionParams {
  id: string;
  ruleId: string;
  version: string;
  contentSha: string;
  content: string;
  statusAtRelease: string;
  releasedBy?: string | null;
  changes?: string | null;
}

/** upsert 工具包当前行的入参 */
export interface SaveToolPackageParams {
  id: string;
  toolId: string;
  version: string;
  sha256: string;
  filesJson: string;
  languages?: string[];
  frameworks?: string[];
  status?: string;
  description?: string | null;
  createdBy?: string | null;
}

/** 保存工具包历史快照的入参（publish 时写入） */
export interface SaveToolPackageVersionParams {
  id: string;
  toolId: string;
  version: string;
  sha256: string;
  filesJson: string;
  languages?: string[];
  frameworks?: string[];
  releasedBy?: string | null;
  changes?: string | null;
}

/** 写审计日志的入参 */
export interface AppendAuditLogParams {
  id: string;
  entityType: ContentAuditLogRow['entity_type'];
  entityId: string;
  action: string;
  detail?: string | null;
  operator: string;
}
