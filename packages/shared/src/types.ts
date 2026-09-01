// ─── 通用类型 ─────────────────────────────────────────────

export type PagedResult<T> = {
  items: T[];
  total: number;
};

export type ApiErrorDTO = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
};

export type ApiResponseEnvelope<T> = {
  code: number;
  message?: string;
  data: T;
  traceId?: string;
};

// ─── 问题（Issue）─────────────────────────────────────────

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

export type IssueSource =
  'guard' | 'inspect' | 'sentinel' | 'security' | 'refactor' | 'performance';

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
  source: IssueSource;
  fingerprint: string;

  // ─── 可选扩展字段（SARIF 兼容，§11.3 / ADR #1）──────────
  /** 污点传播链（source→sink 位置链） */
  codeFlows?: CodeFlow[];
  /** 原始栈追踪行 */
  stack?: string[];
  /** 分类标签（如 validation:NO_VALIDATOR、sca:reachable） */
  taxonomies?: string[];
}

/** SARIF 兼容的污点链单条位置 */
export interface CodeFlowLocation {
  location: { file: string; line?: number; column?: number };
  message?: string;
}

export interface CodeFlowThreadFlow {
  locations: CodeFlowLocation[];
}

/** SARIF-compatible 污点流：source→sink 完整位置链 */
export interface CodeFlow {
  threadFlows: CodeFlowThreadFlow[];
}

// ─── 重构模板（RefactoringTemplate）────────────────────────

export interface ExtractionSuggestion {
  name: string;
  sourceLines: [number, number] | null;
  type: 'function' | 'class' | 'component' | 'module' | 'type' | 'config';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  parameters?: string[];
  returns?: string;
}

export interface RefactoringTemplate {
  ruleId: string;
  target: {
    file: string;
    lines: [number, number];
    symbol?: string;
    type: 'function' | 'class' | 'module' | 'component' | 'type';
  };
  diagnosis: {
    summary: string;
    details?: string;
    metrics: { lines: number; cyclomaticComplexity: number; responsibilityCount: number };
    hotspots?: Array<{ lines: [number, number]; complexity: number; reason?: string }>;
  };
  plan: {
    extractions: ExtractionSuggestion[];
    expectedImprovement?: { linesAfter: number; complexityAfter: number };
  };
  aiPayload?: {
    systemPrompt: string;
    sourceCode: string;
    constraints: string[];
    acceptanceCriteria?: string[];
  };
  confidence: 'high' | 'medium' | 'low';
}

// ─── 检查结果（CheckResult）──────────────────────────────

export interface CheckResult {
  projectId: string;
  timestamp: Date;
  duration: number;
  passed: boolean;
  issues: Issue[];
  summary: { total: number; error: number; warning: number; info: number };
  blockedFiles?: string[];
}

// ─── 健康评分（HealthScore）──────────────────────────────

export interface DimensionScore {
  name: string;
  weight: number;
  score: number;
  issues: number;
}

export interface HealthScore {
  projectId: string;
  timestamp: Date;
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D';
  dimensions: DimensionScore[];
  trend: 'improving' | 'stable' | 'declining';
}

// ─── 巡检报告（InspectionReport）─────────────────────────

export interface AdapterResult {
  adapterId: string;
  adapterName: string;
  duration: number;
  issueCount: number;
  passed: boolean;
  issues: Issue[];
}

export interface InspectionReport {
  projectId: string;
  timestamp: Date;
  scanType: 'full' | 'incremental' | 'scheduled';
  duration: number;
  score: HealthScore;
  issues: Issue[];
  summary: { total: number; error: number; warning: number; info: number };
  adapterResults: AdapterResult[];
  recommendations: string[];
  diff?: {
    newIssues: Issue[];
    resolvedIssues: Issue[];
    scoreChange: number;
  };
}

// ─── 哨兵事件（SentinelEvent）────────────────────────────

export type EventType =
  | 'runtime-exception'
  | 'http-error'
  | 'performance-degradation'
  | 'crash'
  | 'frontend-error'
  | 'white-screen'
  | 'security-incident'
  | 'memory-leak'
  | 'timeout';

export type EventSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type EventSource = 'backend' | 'frontend' | 'middleware' | 'infrastructure';

export interface CodeLocation {
  file: string;
  line?: number;
  column?: number;
  function?: string;
  module?: string;
  stackTrace?: string;
}

export interface EventContext {
  request?: { method: string; path: string; statusCode?: number; duration?: number };
  environment?: string;
  version?: string;
}

export interface Diagnosis {
  category: string;
  impact: string;
  suggestion: string;
  autoFixable: boolean;
}

export interface SentinelEvent {
  id: string;
  projectId: string;
  timestamp: Date;
  type: EventType;
  severity: EventSeverity;
  source: EventSource;
  location: CodeLocation;
  context: EventContext;
  diagnosis: Diagnosis;
  fingerprint: string;
  occurrenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

// ─── 漏洞信息（Vulnerability）────────────────────────────

export interface Vulnerability {
  id: string;
  cveId?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  package: string;
  currentVersion: string;
  vulnerableRange: string;
  fixedVersion?: string;
  dependencyPath: string[];
  isDirectDependency: boolean;
  cvssScore?: number;
  recommendation: string;
  autoFixable: boolean;
}

// ─── 恶意代码（MalwareItem）──────────────────────────────

export interface MalwareItem {
  id: string;
  type:
    | 'reverse-shell'
    | 'data-exfiltration'
    | 'privilege-escalation'
    | 'crypto-ransomware'
    | 'backdoor'
    | 'supply-chain'
    | 'suspicious-behavior';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  file: string;
  line: number;
  pattern: string;
  evidence: string;
}

// ─── 垃圾项（GarbageItem）────────────────────────────────

export interface GarbageItem {
  id: string;
  type: 'unused-file' | 'unused-dependency' | 'dead-code' | 'duplicate-code';
  path: string;
  size: number;
  reason: string;
}

// ─── 经验记录（ExperienceEntry）──────────────────────────

export interface ExperienceEntry {
  id: string;
  projectId: string;
  type: 'true-positive' | 'false-positive' | 'fix-applied' | 'best-practice';
  ruleId: string;
  issueId?: string;
  pattern: string;
  message: string;
  feedback: string;
  source: 'user' | 'auto';
  confidence: number;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── 开源工具集成（Tool Adapter）────────────────────────

export type ToolId =
  | 'eslint'
  | 'semgrep'
  | 'trivy'
  | 'grype'
  | 'gitleaks'
  | 'ort'
  | 'depcheck'
  | 'dep-cruiser'
  | 'jscpd'
  | 'ts-prune'
  | 'tsc'
  | 'autoperf';

export type ToolCategory = 'inspect' | 'security' | 'guard' | 'evolve';

export type ToolPriority = 'P0' | 'P1' | 'P2';

export type ToolInstallMode = 'builtin' | 'on-demand';

export type ToolStatus = 'available' | 'unavailable' | 'error' | 'skipped';

export interface ToolMeta {
  id: ToolId;
  name: string;
  category: ToolCategory;
  priority: ToolPriority;
  installMode: ToolInstallMode;
  description: string;
  cliCommand: string;
  homepage: string;
  license: string;
}

export interface ToolConfig {
  enabled: boolean;
  config?: string;
  /** 规则声明的 issue 分类，透传给适配器作为 mapOutput 的默认 category */
  category?: IssueCategory;
  ignore?: string[];
  severity?: string[];
  scanners?: string[];
  rules?: string[];
  packageManagers?: string[];
  timeout?: number;
  flags?: string[];
}

export interface ToolResult {
  tool: ToolId;
  status: ToolStatus;
  issues: Issue[];
  metadata: {
    version: string;
    duration: number;
    timestamp: Date;
    fileCount: number;
  };
  error?: string;
}

export interface ToolScanOptions {
  projectPath: string;
  projectId: string;
  targetFiles?: string[];
  config?: ToolConfig;
  timeout?: number;
}

/**
 * 工具适配器访问边界声明（F5）。glob 模式为 micromatch 风格（支持 `**` / `*` / `?` / `{a,b}`），
 * 匹配对象是 scan 入参中的路径（相对或绝对均可，分隔符统一为 `/`）。
 */
export interface AccessScope {
  /** 允许读取的路径模式；声明后范围外 targetFiles 记越界告警（不阻断） */
  readPaths?: string[];
  /** 显式排除的路径模式（优先级高于 readPaths，如 node_modules） */
  excludePaths?: string[];
  /** 敏感路径模式：命中即额外告警（仅按路径判断，不读文件内容） */
  sensitivePatterns?: string[];
}

export interface ToolAdapter {
  meta: ToolMeta;
  /** 可选访问边界（F5）：未声明则不做任何 scope 校验，行为与旧版完全一致 */
  accessScope?: AccessScope;
  isAvailable(): Promise<boolean>;
  scan(options: ToolScanOptions): Promise<ToolResult>;
}

/** 扫描前后钩子（F0 Hook/Audit 地基）：before 返回 null 表示阻断本次扫描 */
export interface ToolCallHook {
  before(adapter: ToolAdapter, options: ToolScanOptions): ToolScanOptions | null;
  /** 可改写扫描结果（返回新对象即视为改写） */
  after(adapter: ToolAdapter, result: ToolResult): ToolResult;
}

export interface ToolVersionInfo {
  tool: ToolId;
  installedVersion: string | null;
  recommendedVersion: string;
  binaryPath: string | null;
}

// ─── 工具错误日志（ToolErrorLog）────────────────────────

export interface ToolErrorLog {
  timestamp: Date;
  tool: ToolId;
  error: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  projectId: string;
  hookType?: string;
}

// ─── 审计日志（AuditLog）────────────────────────────────

export type AuditAction =
  | 'tool-executed'
  | 'tool-skipped'
  | 'tool-failed'
  | 'guard-blocked'
  | 'guard-passed'
  | 'whitelist-granted'
  | 'experience-recorded';

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  action: AuditAction;
  projectId: string;
  tool?: ToolId;
  details: Record<string, unknown>;
}

/** 工具调用审计条目（F0）：由调用点在 wrapAdapter 包装的 scan 前后构造 */
export interface AuditEntry {
  timestamp: number;
  adapterName: string;
  sopRuleId?: string;
  action: 'scan' | 'block' | 'skip';
  input: ToolScanOptions;
  output: ToolResult;
  duration: number;
  hookModifications?: string[];
}

// ─── 白名单（Whitelist）─────────────────────────────────

export type WhitelistScope = 'project' | 'file' | 'rule';

export interface WhitelistEntry {
  id: string;
  projectId: string;
  scope: WhitelistScope;
  target: string;
  ruleId?: string;
  reason: string;
  operator: string;
  expiresAt?: Date;
  createdAt: Date;
}

// ─── 工具配置文件（tools.yml 对应类型）─────────────────

export interface ToolsConfig {
  tools: {
    eslint: ToolConfig;
    semgrep: ToolConfig;
    trivy: ToolConfig;
    gitleaks: ToolConfig;
    grype: ToolConfig;
    ort: ToolConfig;
    depcheck: ToolConfig;
    'dependency-cruiser': ToolConfig;
    'ts-prune': ToolConfig;
  };
}

// ─── 降级等级 ───────────────────────────────────────────

export type DegradationLevel = 0 | 1 | 2 | 3 | 4;

// ─── SOP 类型（智汇云脑 — 三维分类体系） ──────────────────

export type GovernanceDomain =
  | 'guard' // 拦截域
  | 'inspect' // 巡检域
  | 'security' // 安全域
  | 'sentinel' // 监控域
  | 'evolve'; // 演进域

export type ActionType =
  | 'scan' // 扫描检测
  | 'block' // 拦截阻断
  | 'score' // 评分量化
  | 'alert' // 告警响应
  | 'suggest' // 修复建议
  | 'calibrate'; // 进化校准

export type DataSource =
  | 'external' // 外部标准
  | 'internal' // 内部模式
  | 'community' // 社区贡献
  | 'official'; // 官方维护

export type RuleLifecycleStatus = 'draft' | 'trial' | 'active' | 'deprecated';

export interface SopVersion {
  version: string;
  knowledge: string;
  experience: string;
  malware: string;
  publishedAt: Date;
  hash: string;
  size: number;
}

export interface SopDiff {
  version: string;
  fromVersion: string;
  compatibility: string;
  added: unknown[];
  removed: string[];
  modified: unknown[];
  unchanged: string[];
  metadata: {
    totalRules: number;
    diffSize: number;
    hash: string;
  };
}

export interface SyncResult {
  updated: boolean;
  reason?: 'already_latest' | 'compatibility_error' | 'hash_mismatch' | 'network_error';
  fromVersion?: string;
  toVersion?: string;
  ruleCount?: number;
}

// ─── 输出映射器（Output Mapper）──────────────────────────

export type ToolOutputMapper = (rawOutput: unknown) => Issue[];

export interface ToolMapperRegistry {
  [toolId: string]: ToolOutputMapper;
}

// ─── 门禁配置（GuardConfig）────────────────────────────

export interface GuardCheckItem {
  enabled: boolean;
  checks: string[];
  timeout: number;
}

export interface GuardConfig {
  guard: {
    'pre-commit': GuardCheckItem;
    'pre-push': GuardCheckItem;
    ci: GuardCheckItem;
  };
}

// ─── Git Hook 类型 ─────────────────────────────────────

export type HookType = 'pre-commit' | 'pre-push' | 'post-commit' | 'post-merge';

// ─── 备用规则（Built-in fallback rules）────────────────

export interface BuiltinRule {
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  pattern?: string;
}

// ─── 云脑同步（Cloud Sync）────────────────────────────

export interface CloudSyncRule {
  tool: ToolId;
  sourcePath: string;
  updateFrequency: 'daily' | 'weekly' | 'monthly' | 'emergency';
  localPath: string;
}

export interface CloudSyncConfig {
  rules: CloudSyncRule[];
}
