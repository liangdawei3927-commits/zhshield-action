// ─── 通用类型 ─────────────────────────────────────────────

/** 分页查询结果：items 为当前页数据，total 为满足条件的总条数 */
export type PagedResult<T> = {
  items: T[];
  total: number;
};

/** 统一错误响应体：code 为业务错误码，details 承载可选结构化明细 */
export type ApiErrorDTO = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
};

/** 统一响应信封：HTTP 层返回体，业务数据在 data 字段 */
export type ApiResponseEnvelope<T> = {
  code: number;
  message?: string;
  data: T;
  traceId?: string;
};

// ─── 问题（Issue）─────────────────────────────────────────

/** 问题严重级别 */
export type IssueSeverity = 'error' | 'warning' | 'info';

/** 问题分类维度（决定面板归类与规则归属域） */
export type IssueCategory =
  | 'architecture'
  | 'security'
  | 'quality'
  | 'performance'
  | 'documentation'
  | 'test'
  | 'dependency'
  | 'refactoring';

/** 问题来源模块：产出该 Issue 的治理域/工具 */
export type IssueSource =
  | 'guard' | 'inspect' | 'sentinel' | 'security' | 'refactor' | 'performance';

/** 问题（Issue）：各域检测结果的统一表示，跨域聚合与展示的公共契约 */
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

/** 污点线程流：同一 source→sink 传播链上的位置序列 */
export interface CodeFlowThreadFlow {
  locations: CodeFlowLocation[];
}

/** SARIF-compatible 污点流：source→sink 完整位置链 */
export interface CodeFlow {
  threadFlows: CodeFlowThreadFlow[];
}

// ─── 检查结果（CheckResult）──────────────────────────────

/** 检查结果：一次检查/巡检的结论（通过与否 + 问题清单 + 分级统计） */
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

/** 维度评分：健康分某一维度（架构/安全/性能…）的得分与其在总分中的权重 */
export interface DimensionScore {
  name: string;
  weight: number;
  score: number;
  issues: number;
}


// ─── 巡检报告（InspectionReport）─────────────────────────


// ─── 哨兵事件复现统计（SentinelOccurrence）────────────────

/** 哨兵事件复现统计：累计出现次数与首末次出现时间（@zh/sentinel、@zh/db 入参三处复用） */
export interface SentinelOccurrence {
  occurrenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

// ─── 垃圾项（GarbageItem）────────────────────────────────

/** 垃圾项类型（垃圾清理域 owner = @zh/garbage）：
 *  unused-file / build-artifact 由文件系统检测器产出；
 *  dead-code / duplicate-code / unused-dependency 由 garbage 域 SOP 规则产出。 */
export type GarbageItemType =
  'unused-file' | 'unused-dependency' | 'dead-code' | 'duplicate-code' | 'build-artifact';

/** 垃圾项：垃圾清理域产出的可清理对象（未使用文件/依赖、死代码、重复代码、构建产物） */
export interface GarbageItem {
  id: string;
  type: GarbageItemType;
  path: string;
  size: number;
  reason: string;
}

// ─── 经验记录（ExperienceEntry）──────────────────────────


// ─── 开源工具集成（Tool Adapter）────────────────────────

/** 已接入的工具 id（唯一来源：类型与运行时常量同源，供规则校验"声明的 tool 是否真实存在"）。
 *  伪 tool（如 custom-ast-scanner）曾导致规则静默空跑，故需要运行时可校验的清单。 */
export const TOOL_IDS = [
  'eslint',
  'semgrep',
  'trivy',
  'grype',
  'gitleaks',
  'ort',
  'depcheck',
  'dep-cruiser',
  'jscpd',
  'ts-prune',
  'tsc',
  'autoperf',
  'sentinel',
  'prettier',
  'commit-lint',
  'npm-audit',
  'sonarway',
] as const;

/** 工具 id：由 TOOL_IDS 运行时常量推导，新增工具须先改 TOOL_IDS */
export type ToolId = (typeof TOOL_IDS)[number];

/** 工具分类：决定该工具参与哪个治理域的流程 */
export type ToolCategory = 'inspect' | 'security' | 'guard' | 'evolve';

/** 工具优先级：P0 为关键路径工具，资源紧张时优先保障 */
export type ToolPriority = 'P0' | 'P1' | 'P2';

/** 工具安装方式：随包内置（builtin）或按需下载（on-demand） */
export type ToolInstallMode = 'builtin' | 'on-demand';

/** 工具执行状态：含跳过（skipped）与降级告警（warning）等非成功态 */
export type ToolStatus = 'available' | 'unavailable' | 'error' | 'skipped' | 'success' | 'warning';

/** 工具元信息：适配器的静态描述（名称、分类、CLI 命令、许可等） */
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

/** 工具配置：单个工具的开关与参数（对应 tools.yml 中每个工具节点） */
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
  /** commit-lint：提交信息校验正则与主题长度上限 */
  pattern?: string;
  maxSubjectLength?: number;
  /** 规则顶层 thresholds（minLines/minTokens/minSimilarity/ignore 等），ContentInterpreter 从 SopRule.content 并入后透传给适配器 */
  thresholds?: Record<string, unknown>;
}

/** 工具扫描结果：一次工具执行的产出（问题清单 + 运行元信息），status 反映是否真正跑通 */
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

/** 工具扫描入参：适配器 scan 的入参（projectPath 锚定扫描根，targetFiles 为空表示全量） */
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

/** 工具适配器：所有开源扫描工具的统一接入契约（可用性探测 + 扫描） */
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

/** 工具版本信息：本机已装版本与推荐版本的对比，installedVersion 为 null 表示未安装 */
export interface ToolVersionInfo {
  tool: ToolId;
  installedVersion: string | null;
  recommendedVersion: string;
  binaryPath: string | null;
}

// ─── 工具错误日志（ToolErrorLog）────────────────────────

/** 工具错误日志：工具执行/钩子异常的结构化记录，保留命令、退出码与原始输出便于复现 */
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

/** 审计动作：可写入审计日志的动作分类 */
export type AuditAction =
  | 'tool-executed'
  | 'tool-skipped'
  | 'tool-failed'
  | 'guard-blocked'
  | 'guard-passed'
  | 'whitelist-granted'
  | 'experience-recorded';

/** 审计日志条目：持久化的操作审计记录，details 承载动作相关结构化明细 */
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

/** 白名单作用范围：整项目 / 单文件 / 单规则 */
export type WhitelistScope = 'project' | 'file' | 'rule';


// ─── 工具配置文件（tools.yml 对应类型）─────────────────

/** 工具配置文件：tools.yml 的对应类型，按工具 id 固定键出各工具配置 */
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

/**
 * 降级等级（DegradationManager 消费）：
 *   0 = 全量；1 = 跳过已出错工具；2 = 仅保留核心工具（eslint/semgrep）；3 及以上 = 全部跳过并启用兜底规则。
 */
export type DegradationLevel = 0 | 1 | 2 | 3 | 4;

// ─── SOP 类型（智汇云脑 — 三维分类体系） ──────────────────

/**
 * 治理域清单（**唯一来源**：运行时常量与类型同源）。
 *
 * 曾出现三份互不同步的域清单——shared 类型、kernel `GOVERNANCE_DOMAIN_DIRS`、
 * cli `sop-dir.ts` 的 `DOMAIN_DIRS`；新增 `garbage` 域时漏改后者，导致
 * 兼容分支判定失效。新增域请只改这里。
 */
export const GOVERNANCE_DOMAINS = [
  'guard', // 拦截域
  'inspect', // 巡检域
  'security', // 安全域
  'sentinel', // 监控域
  'evolve', // 演进域
  'refactor', // 重构域
  'garbage', // 垃圾清理域
] as const;

/** 治理域：由 GOVERNANCE_DOMAINS 运行时常量推导，新增域须先改该常量 */
export type GovernanceDomain = (typeof GOVERNANCE_DOMAINS)[number];

/**
 * 「全量巡检」默认覆盖的治理域 —— 唯一来源，避免各调用点各写一份而漂移。
 *
 * 语义边界（与《导航各司其职》一致）：
 *   · 不传 domains 的调用方 = 跑一次全量巡检，本清单即其覆盖面；
 *   · 各司其职约束的是「触发权与判定权域内独占」——面板上的垃圾清理页只能触发
 *     garbage 域、安全中心只能触发 security 域；而全量巡检是一个**跨域入口**，
 *     一并执行三者并各自独立判定，不构成借调。
 *   · guard / sentinel / evolve / refactor 不在此列：它们各有独立命令与触发时机。
 *
 * 变更提示：新增治理域并希望进入全量巡检时，改这里一处即可；桌面端各面板
 * 均显式传 domains，不受本清单影响。
 */
export const INSPECT_SCOPE_DOMAINS = ['inspect', 'security', 'garbage'] as const;

/**
 * SOP 规则枚举字段的**运行时常量真源**（与类型同源）。
 *
 * 此前这些取值只有 TypeScript 联合类型、没有运行时常量，于是加载器只能写
 * `meta.status as RuleLifecycleStatus` —— 类型断言在运行期不生效，云端下发
 * `status: actived`（拼错）会被原样接受：规则进入 registry 却不匹配任何生命周期，
 * `getActive()` 永远取不到它 ⇒ **规则静默空跑，本地零告警**。
 * 新增取值请只改这里，类型会自动跟随。
 */
export const ACTION_TYPES = ['scan', 'block', 'score', 'alert', 'suggest', 'calibrate'] as const;

/** 数据来源：规则依据的知识出处，取值与规则 ID 的第三段一致 */
export const DATA_SOURCES = ['external', 'internal', 'community', 'official'] as const;

/** 规则生命周期：draft 草稿 → trial 试运行 → active 生效 → deprecated 废弃 */
export const RULE_LIFECYCLE_STATUSES = ['draft', 'trial', 'active', 'deprecated'] as const;

/** 执行模式：规则触发时机 */
export const EXECUTION_MODES = ['sync', 'async', 'periodic', 'event'] as const;

/** 规则严重级别（含 'error'：对齐 ESLint/semgrep 的 ERROR 档） */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'error'] as const;


/** SOP 知识包版本：一次云脑发布产出的知识/经验/恶意库快照及其哈希 */
export interface SopVersion {
  version: string;
  knowledge: string;
  experience: string;
  malware: string;
  publishedAt: Date;
  hash: string;
  size: number;
}

/** SOP 版本 diff 的元数据：目标版本规则总数、diff 体积与完整性哈希 */
export interface SopDiffMetadata {
  totalRules: number;
  diffSize: number;
  hash: string;
}

/**
 * SOP 版本差异：两版知识包之间的规则增删改对比与兼容性结论。
 *
 * 泛型 T 为规则条目类型：默认 `unknown`（跨包传输只关心数量/ID 的场景不约束载荷），
 * kernel 侧以 `SopDiff<SopRule>` 收窄，使 applyDiff 可直接按规则对象消费 added/modified。
 */
export interface SopDiff<T = unknown> {
  version: string;
  fromVersion: string;
  compatibility: string;
  added: T[];
  removed: string[];
  modified: T[];
  unchanged: string[];
  metadata: SopDiffMetadata;
}


// ─── 输出映射器（Output Mapper）──────────────────────────

/** 输出映射器签名：把工具原始输出（stdout/JSON）转换为统一 Issue 列表 */
export type ToolOutputMapper = (rawOutput: unknown) => Issue[];

/** 映射器注册表：按工具 id 登记各自的输出映射函数 */
export interface ToolMapperRegistry {
  [toolId: string]: ToolOutputMapper;
}

// ─── 门禁配置（GuardConfig）────────────────────────────

/** 门禁检查项：单个钩子阶段（pre-commit/pre-push/ci）的开关、检查项与超时 */
export interface GuardCheckItem {
  enabled: boolean;
  checks: string[];
  timeout: number;
}

/** 门禁配置：guard 域配置结构，按钩子阶段固定键出检查项 */
export interface GuardConfig {
  guard: {
    'pre-commit': GuardCheckItem;
    'pre-push': GuardCheckItem;
    ci: GuardCheckItem;
  };
}

// ─── Git Hook 类型 ─────────────────────────────────────

/** Git 钩子阶段类型 */
export type HookType = 'pre-commit' | 'pre-push' | 'post-commit' | 'post-merge';

// ─── 备用规则（Built-in fallback rules）────────────────

/** 内置兜底规则：降级等级 ≥3 时替代外部工具产出（不含文件定位，file 以 projectId 占位） */
export interface BuiltinRule {
  ruleId: string;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  pattern?: string;
}

// ─── 云脑同步（Cloud Sync）────────────────────────────

/** 云脑同步规则：声明某工具从哪个远端路径按什么频率同步到本地路径 */
export interface CloudSyncRule {
  tool: ToolId;
  sourcePath: string;
  updateFrequency: 'daily' | 'weekly' | 'monthly' | 'emergency';
  localPath: string;
}

/** 云脑同步配置：全部同步规则的集合 */
export interface CloudSyncConfig {
  rules: CloudSyncRule[];
}
