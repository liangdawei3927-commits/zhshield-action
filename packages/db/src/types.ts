// ─── 数据库行类型 ─────────────────────────────────────────

/** projects 表行：被巡检项目登记项，path 唯一（迁移 001；迁移 009 另加可空 org_id） */
export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  added_at: string;
  updated_at: string;
}

/** scores 表行：项目某次健康评分快照，取最新一条即当前分（迁移 002） */
export interface ScoreRow {
  id: number;
  project_id: string;
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: string;
  trend: 'improving' | 'stable' | 'declining';
  created_at: string;
}

/** scanning_results 表行：按 (project, source) 记录的单工具扫描结论（迁移 003） */
export interface ScanningResultRow {
  id: number;
  project_id: string;
  source: string;
  passed: number;
  summary: string;
  report: string | null;
  created_at: string;
}

/** rules 表行：规则的启用状态与最近一次变更留痕（迁移 004） */
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

/** experiences 表行：经验校准样本（全局库，不随项目删除，迁移 005/012） */
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

/** 新增项目入参（added_at/updated_at 交由 SQLite 默认值填充） */
export interface CreateProjectParams {
  id: string;
  name: string;
  path: string;
}

/** 写入评分入参（dimensions 为各维度评分明细的序列化文本） */
export interface SaveScoreParams {
  projectId: string;
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: string;
  trend: 'improving' | 'stable' | 'declining';
}

/** 写入扫描结果入参（passed 为布尔，落库转 0/1；report 缺省写 NULL） */
export interface SaveScanResultParams {
  projectId: string;
  source: string;
  passed: boolean;
  summary: string;
  report?: string;
}

/** 规则 upsert 入参（按 rule_id 覆盖；state 缺省沿用库中现值，不传即不改） */
export interface UpsertRuleParams {
  ruleId: string;
  state?: 'active' | 'disabled' | 'deprecated' | 'experimental';
  severity?: string;
  weight?: number;
  reason?: string;
  changedBy?: string;
}

// ─── Sentinel Events ───────────────────────────────────────

/** sentinel_events 表行：哨兵事件持久化记录，validation/context/history 为 JSON 文本（迁移 006） */
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

/** 新增哨兵事件入参（首次落库；时间字段在此以 Date 传入，落库转文本） */
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

/** 哨兵事件局部更新入参：仅写入显式传入的字段（undefined 跳过），用于状态流转与去重累加 */
export interface UpdateSentinelEventParams {
  id: string;
  status?: string;
  validation?: string;
  history?: string;
  occurrenceCount?: number;
  lastSeen?: Date;
}

/** 哨兵事件列表过滤条件（全不传即不过滤；limit/offset 为分页） */
export interface ListSentinelEventsFilter {
  projectId?: string;
  status?: string;
  severity?: 'p1' | 'p2' | 'p3';
  limit?: number;
  offset?: number;
}

/** 写入经验样本入参（detail/source 可空，落库为 NULL；created_at 用默认值） */
export interface SaveExperienceParams {
  id: string;
  projectId: string;
  ruleId: string;
  type: 'true-positive' | 'false-positive' | 'suggestion' | 'custom';
  detail?: string;
  source?: string;
}

/** 技术债治理动作入参：一次还债动作的度量与排期（issueIds 落库为 TEXT，迁移 007） */
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

/** debt_actions 表行：技术债动作，主键 (project_id, action_id)（迁移 007） */
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

/** 技术债动作状态流转入参：只改 status，定位键为 (projectId, actionId) */
export interface UpdateDebtActionStatusParams {
  projectId: string;
  actionId: string;
  status: SaveDebtActionParams['status'];
}

/** 写入技术债指数快照入参（debtIndex 为该时点的债务指数） */
export interface SaveDebtSnapshotParams {
  projectId: string;
  debtIndex: number;
}

/** debt_snapshots 表行：技术债指数时序快照，取 id 最大一条即当前指数（迁移 007） */
export interface DebtSnapshotRow {
  id: number;
  project_id: string;
  debt_index: number;
  created_at: string;
}

// ─── M3 轻量 Org 多租户（迁移 009）────────────────────────

/** orgs 表行：租户组织（迁移 009） */
export interface OrgRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

/** org_members 表行：组织成员与角色，(org_id, user_id) 唯一；随组织级联删除（迁移 009） */
export interface OrgMemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  created_at: string;
}

/**
 * rule_scope 表行：按租户的规则启用/版本快照。
 * org_id 为 NULL = 平台默认（全局兜底）；组织行覆盖平台行的合并语义在查询层实现（迁移 009）。
 */
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

/** project_features 表行：项目画像快照（客户端 T0 注册提交、服务端 T1 resolve 依据），每项目唯一（迁移 009） */
export interface ProjectFeatureRow {
  id: string;
  project_id: string;
  framework: string | null;
  language: string | null;
  features_json: string;
  schema_version: number;
  updated_at: string;
}

/** 新增组织入参（ownerUserId 落库为 owner_user_id） */
export interface CreateOrgParams {
  id: string;
  name: string;
  ownerUserId: string;
}

/** 新增组织成员入参（role 复用 OrgMemberRow['role'] 保证三处取值不漂移） */
export interface AddOrgMemberParams {
  id: string;
  orgId: string;
  userId: string;
  role: OrgMemberRow['role'];
}

/** rule_scope upsert 入参（enabled 为布尔，落库转 0/1；orgId=null 写平台默认行） */
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

/** 写入项目画像入参（features 数组序列化为 features_json 落库） */
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
  updated_at: string;
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
