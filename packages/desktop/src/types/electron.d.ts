export interface SopAPI {
  getVersion: () => Promise<{
    version: string;
    knowledge: string;
    experience: string;
    malware: string;
    publishedAt: string;
  } | null>;
  syncNow: () => Promise<{
    updated: boolean;
    reason?: string;
    fromVersion?: string;
    toVersion?: string;
    ruleCount?: number;
  }>;
  getStats: () => Promise<{
    totalRules: number;
    byDomain: Record<string, number>;
    byAction: Record<string, number>;
    byStatus: Record<string, number>;
  }>;
  getSyncHealth: () => Promise<{
    level: number;
    stale: boolean;
    lastSync: string | null;
  }>;
  emergencyUpdate: (rulesJson: string) => Promise<{ success: boolean; reason?: string }>;
  checkRules: (domain?: string) => Promise<unknown[]>;
}

/** @zh/guard GuardReport shape (serializable) */
export interface GuardReportData {
  summary: {
    totalChecks: number;
    passed: number;
    blocked: number;
    warnings: number;
  };
  checks: Array<{
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    category?: string;
    severity?: 'low' | 'medium' | 'high' | 'critical';
  }>;
  metadata: {
    duration: number;
    timestamp: string;
  };
}

/** @zh/inspect InspectionReport shape (serializable) */
export interface InspectionReportData {
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failures: number;
  };
  checks: Array<{
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail' | 'attention';
    detail: string;
    category?: string;
    /** 来源引擎/适配器标识（如 'ai-code-review' / 'semgrep' / 'eslint'） */
    source?: string;
  }>;
  metadata: {
    duration: number;
    timestamp: string;
  };
}

/** @zh/security SecurityScanReport shape (serializable) */
export interface SecurityScanReportData {
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    malwareTotal: number;
    garbageTotal: number;
    garbageSize: number;
  };
  findings: Array<{
    id: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line?: number;
    description: string;
    recommendation?: string;
  }>;
  malware: Array<{
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    description: string;
    file: string;
    line: number;
    pattern: string;
    evidence: string;
  }>;
  garbage: Array<{
    id: string;
    type: string;
    path: string;
    size: number;
    reason: string;
  }>;
  securityScore: number;
  metadata: {
    duration: number;
    timestamp: string;
  };
}

/** 性能优化检测报告（SOP inspect performance 维度，serializable） */
export interface PerformanceReportData {
  summary: { total: number; autoFixable: number };
  issues: Array<{
    id: string;
    ruleId: string;
    severity: string;
    file: string;
    line?: number;
    message: string;
    suggestion?: string;
    autoFixable: boolean;
  }>;
  metadata: { duration: number; timestamp: string };
}

/** HealthScore shape (serializable) */
export interface HealthScoreData {
  score: number;
  dimensions: Array<{
    name: string;
    score: number;
    weight: number;
    issues?: number;
  }>;
  summary: string;
  timestamp: string;
}

/** 项目画像（可序列化子集，供前端列出模块用于模块级评分） */
export interface ModuleProfileData {
  path: string;
  type: string;
}
export interface ProjectProfileData {
  type: string;
  modules: ModuleProfileData[];
}

/** @zh/refactor RefactorReport shape (serializable) */
export interface RefactorReportData {
  timestamp: string;
  projectRoot: string;
  totalFiles: number;
  scannedFiles: number;
  totalSmells: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  files: Array<{
    filePath: string;
    totalSmells: number;
    maintainabilityScore: number;
    refactorPriority: string;
    smells: Array<{
      id: string;
      ruleId: string;
      category: string;
      severity: string;
      message: string;
      location: { filePath: string; line: number; column: number; endLine: number; endColumn: number };
      context: { metric: string; value: number; threshold: number };
      suggestion: { type: string; description: string; priority: string };
    }>;
  }>;
  summary: {
    criticalFiles: number;
    needsImmediateAction: number;
    suggestionsByType: Record<string, number>;
  };
}

export interface PipelineReportData {
  passed: boolean;
  stage: string;
  timestamp: string;
  guard?: GuardReportData;
  inspect?: InspectionReportData;
  security?: SecurityScanReportData;
  refactor?: RefactorReportData;
  summary?: Record<string, unknown>;
  error?: string | null;
}

/** 垃圾清理结果（serializable） */
export interface GarbageCleanResultData {
  /** 回收站批次 ID，用于恢复 */
  batchId: string;
  /** 成功清理的条目 */
  cleaned: Array<{ id: string; path: string; size: number }>;
  /** 释放的字节数 */
  freedBytes: number;
  /** 清理失败的条目与原因 */
  failed: string[];
}

/** 回收站恢复结果（serializable） */
export interface GarbageRestoreResultData {
  restored: number;
  restoredBytes: number;
  failed: string[];
}

/** 可更新依赖条目 */
export interface OutdatedDependencyData {
  name: string;
  current: string;
  latest: string;
  isSecurityUpdate: boolean;
  description?: string;
}

/** 依赖管家结果（serializable，来自 @zh/dependency 依赖管家引擎） */
export interface DependencyReportData {
  schemaVersion: number;
  targetId: string;
  ecosystem: string;
  /** 直接依赖数 */
  direct: number;
  /** 传递依赖数 */
  transitive: number;
  /** 节点总数（直接 + 传递） */
  total: number;
  /** 依赖边数 */
  edgeCount: number;
  /** 锁文件状态：存在性 / 与声明一致性 / 哈希完整性 */
  lockfile: {
    present: boolean;
    consistent: boolean;
    integrityVerified: boolean;
    lastModified?: string;
  };
  /** 信任状态统计（verified / suspicious / compromised / unknown） */
  trustCounts: Record<string, number>;
  /** 许可证矩阵 */
  licenseMatrix: {
    total: number;
    byCategory: Record<string, number>;
    entries: Array<{
      name: string;
      version: string;
      license: string;
      category: string;
      risk: string;
      reason?: string;
    }>;
  };
  /** 投毒检测发现（来自 @zh/dependency typosquat-detector 适配器） */
  typosquatFindings: TyposquatFindingData[];
  /** 投毒检测失败信息（未失败时不返回） */
  typosquatError?: string;
  /** 锁文件完整性校验结果（来自 @zh/dependency lockfile-verifier 适配器） */
  lockfileVerification: LockfileVerificationData;
  /** 锁文件校验失败信息（未失败时不返回） */
  lockfileError?: string;
  /** 升级评估结果（来自 @zh/dependency upgrade-evaluator 适配器） */
  upgradeAssessments: UpgradeAssessmentData[];
  /** 升级评估失败信息（未失败时不返回） */
  upgradeError?: string;
  /** 环境一致性检查条目（来自 @zh/dependency env-consistency 适配器） */
  envEntries: EnvEntryData[];
  /** 环境一致性检查失败信息（未失败时不返回） */
  envError?: string;
  /** 可更新依赖列表 */
  outdatedDeps?: OutdatedDependencyData[];
  /** 生成时间（ISO 8601） */
  generatedAt: string;
  /** 失败信息（成功时为 null） */
  error?: string | null;
}

/** 投毒检测发现（serializable，镜像 @zh/dependency TyposquatFinding） */
export interface TyposquatFindingData {
  nodeId: string;
  risk: 'high' | 'medium' | 'low';
  signals: {
    nameSimilarity?: { target: string; score: number };
    behaviorFlags?: string[];
  };
  evidence: string[];
}

/** 锁文件完整性校验结果（serializable，镜像 @zh/dependency LockfileVerification） */
export interface LockfileVerificationData {
  status: 'clean' | 'modified' | 'missing';
  lockfilePath?: string;
  diffs: Array<{
    name: string;
    declaredVersion: string;
    lockedVersion: string;
  }>;
  integrityFailures: string[];
}

/** 单个依赖的升级评估（serializable，镜像 @zh/dependency UpgradeAssessment） */
export interface UpgradeAssessmentData {
  nodeId: string;
  candidates: Array<{
    targetVersion: string;
    risk: 'low' | 'medium' | 'high';
    breakingChanges: Array<{
      type: string;
      description: string;
      affectedFiles: string[];
    }>;
    securityRelevant: boolean;
    reason: string;
  }>;
}

/** 环境一致性检查条目（serializable，镜像 @zh/dependency EnvEntry） */
export interface EnvEntryData {
  kind: 'lockfile-drift' | 'runtime-version' | 'env-file-diff' | 'ci-vs-local';
  name: string;
  expected: string;
  actual: string;
  severity: 'error' | 'warning' | 'info';
  detail: string;
}

/** 技术债仪表盘结果（serializable，来自 @zh/scoring tech-debt 引擎） */
export interface TechDebtReportData {
  projectId: string;
  generatedAt: string;
  /** 债务指数 0-100（越高越重） */
  debtIndex: number;
  trend: { period: string; delta: number };
  byModule: Array<{ module: string; debtShare: number; hotness: number; interestTotal: number }>;
  byCategory: Array<{ category: string; count: number; weight: number }>;
  actionList: Array<{
    actionId: string;
    issueIds: string[];
    module: string;
    category: string;
    interestScore: number;
    interestBreakdown: {
      severityFactor: number;
      hotnessFactor: number;
      densityFactor: number;
      exposureFactor: number;
    };
    principalEstimate: number;
    roi: number;
    recommended: boolean;
    status: string;
  }>;
  error?: string | null;
}

/** 密钥全生命周期报告（serializable，来自 @zh/security secrets 引擎；值脱敏前4后4，不落明文） */
export interface SecretReportData {
  findings: Array<{
    secretId: string;
    type: string;
    displayValue: string;
    location: { file: string; line: number; commit: string; branch?: string };
    introducedAt: string;
    stillReferenced: boolean;
    pushedToRemote: boolean;
    remotePublic: boolean;
    severity: string;
    status: string;
  }>;
  summary: {
    total: number;
    critical: number;
    active: number;
    historyFound: number;
  };
  lastScannedCommit: string;
  error?: string | null;
}

/** 原生保存对话框结果 */
export interface SaveDialogResult {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export interface EngineAPI {
  runGuard: (projectPath: string, options?: Record<string, unknown>) => Promise<GuardReportData>;
  runInspect: (projectPath: string) => Promise<InspectionReportData>;
  runSecurity: (projectPath: string) => Promise<SecurityScanReportData>;
  cleanGarbage: (projectPath: string, items: Array<{ id: string; path: string; size: number; type: string }>) => Promise<GarbageCleanResultData>;
  restoreGarbage: (projectPath: string, batchId: string) => Promise<GarbageRestoreResultData>;
  runPerformance: (projectPath: string) => Promise<PerformanceReportData>;
  runRefactor: (projectPath: string) => Promise<RefactorReportData>;
  runDeps: (projectPath: string) => Promise<DependencyReportData>;
  runTechDebt: (projectPath: string) => Promise<TechDebtReportData>;
  planDebtRepayment: (projectPath: string, actionId: string, opts?: { sprint?: string; gate?: 'allow-with-record' }) => Promise<void>;
  verifyDebtRepaid: (projectPath: string, actionId: string) => Promise<boolean>;
  dismissDebtAction: (projectPath: string, actionId: string) => Promise<void>;
  runSecrets: (projectPath: string) => Promise<SecretReportData>;
  markSecretRotating: (secretId: string) => Promise<void>;
  verifySecretRotated: (secretId: string) => Promise<boolean>;
  dismissSecret: (secretId: string, reason: string) => Promise<void>;
  getScore: (projectId: string) => Promise<HealthScoreData | null>;
  getScoreHistory: (projectId: string) => Promise<HealthScoreData[]>;
  getProfile: (projectPath: string) => Promise<ProjectProfileData | null>;
  runPipeline: (projectPath: string, options?: { dryRun?: boolean; sop?: boolean; presetName?: string }) => Promise<PipelineReportData>;
  runProfile: (projectPath: string) => Promise<{ profile: unknown; questions: unknown; drift: unknown }>;
}

export interface SyncAPI {
  syncRules: () => Promise<unknown[]>;
  getRulesStatus: () => Promise<Array<{ toolId: string; localVersion: string | null; stale: boolean }>>;
  emergencyUpdate: (toolId: string) => Promise<unknown>;
  submitExperience: (records: unknown[]) => Promise<{ sent: number; queued: number; failed: number }>;
  getQueueStatus: () => Promise<{ queueLength: number }>;
}

export interface SentinelAPI {
  getEvents: (options?: { status?: string; severity?: string }) => Promise<SentinelEvent[]>;
  getEvent: (id: string) => Promise<SentinelEvent | undefined>;
  startMonitoring: (projectId: string, projectPath: string) => Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }>;
  getState: () => Promise<{ enabled: boolean }>;
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
}

export interface SuggestionData {
  ruleId: string;
  message: string;
  confidence: number;
  source: string;
}

export interface RuleWeightData {
  ruleId: string;
  weight: number;
  falsePositiveRate: number;
  totalSamples: number;
  lastAdjustedAt: string;
}

export interface EvolveAPI {
  getSuggestions: (projectId: string) => Promise<SuggestionData[]>;
  listExperiences: (projectId: string) => Promise<unknown[]>;
  getRuleWeights: () => Promise<RuleWeightData[]>;
  recordExperience: (entry: unknown) => Promise<unknown>;
  autoAdjustWeights: () => Promise<RuleWeightData[]>;
}

export interface BackupRecordData {
  id: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  timestamp: string;
  type: string;
  status: string;
  trigger: string;
  duration: number;
  cloudBackupId?: string;
  cloudServerUrl?: string;
  githubCommitHash?: string;
  githubCommitMessage?: string;
  githubRepoUrl?: string;
  githubBranch?: string;
  localBackupPath?: string;
  backupSize?: number;
  fileCount?: number;
  error?: string;
}

export interface BackupResultData {
  projectId: string;
  projectName: string;
  trigger: string;
  overallStatus: string;
  timestamp: string;
  duration: number;
  error?: string;
  results: Array<{
    type: string;
    success: boolean;
    error?: string;
    [key: string]: unknown;
  }>;
}

export interface BackupConfigData {
  cloud: { enabled: boolean; serverUrl: string; [key: string]: unknown };
  github: { enabled: boolean; owner: string; repo: string; [key: string]: unknown };
  local: { enabled: boolean; backupDir: string; [key: string]: unknown };
  schedule: { enabled: boolean; frequency: string; time: string; [key: string]: unknown };
}

export interface BackupAPI {
  executeBackup: (projectPath: string, trigger?: string) => Promise<BackupResultData>;
  getRecords: (projectId?: string) => Promise<BackupRecordData[]>;
  getRecord: (recordId: string) => Promise<BackupRecordData | null>;
  deleteRecord: (recordId: string) => Promise<boolean>;
  getConfig: (projectPath: string) => Promise<BackupConfigData>;
  saveConfig: (projectPath: string, config: BackupConfigData) => Promise<void>;
  authorizeGitHub: () => Promise<boolean>;
  openFolder: (folderPath: string) => Promise<boolean>;
}

export interface PipelineProgress {
  stage: string;
  message: string;
  progress: number; // 0.0 ~ 1.0
}

/** 任务类型：对应各引擎检查（360 卫士式多任务并发） */
export type TaskKind =
  | 'pipeline' // 一键体检（流水线）
  | 'inspect' // 质量巡检
  | 'security' // 安全扫描（杀毒 + 垃圾发现）
  | 'garbageClean' // 垃圾清理
  | 'garbageRestore' // 回收站恢复
  | 'performance' // 优化加速
  | 'guard' // 门禁扫描
  | 'refactor'; // 代码重构

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务信息（主进程任务注册表 → 渲染进程） */
export interface TaskInfo {
  id: string;
  kind: TaskKind;
  projectPath: string;
  status: TaskStatus;
  stage?: string;
  message?: string;
  progress: number; // 0.0 ~ 1.0
  startedAt: string;
  finishedAt?: string;
  /** 任务完成后的报告（仅 status === 'done' 时存在） */
  result?: unknown;
  error?: string;
  /** 排队位置（仅 status === 'queued' 时存在） */
  queuePosition?: number;
}

export interface TaskAPI {
  start: (kind: TaskKind, projectPath: string, options?: Record<string, unknown>) => Promise<TaskInfo>;
  list: () => Promise<TaskInfo[]>;
  cancel: (id: string) => Promise<boolean>;
  onChanged: (callback: (task: TaskInfo) => void) => () => void;
}

export interface AiToolConfigData {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'linter' | 'cli';
  configFile: string;
}

export interface AiProjectWriteResultData {
  path: string;
  ok: boolean;
  error?: string;
  files: string[];
}

export interface AiApplyResultData {
  saved: boolean;
  projects: AiProjectWriteResultData[];
}

export interface AiAPI {
  loadConfig: () => Promise<AiToolConfigData>;
  saveConfig: (config: AiToolConfigData, projectPaths: string[]) => Promise<AiApplyResultData>;
}

export interface GuardHooksStatusData {
  hasGitDir: boolean;
  installed: string[];
}

export interface GuardHooksInstallResultData {
  ok: boolean;
  installed: string[];
  skipped: string[];
  reason?: string;
}

/** 门禁报告落库记录（JSONL 持久化，CLI/桌面/HTTP 三端共享） */
export interface GuardReportRecordData {
  timestamp: string;
  triggerSource: string;
  ok: boolean | null;
  riskLevel: 'low' | 'medium' | 'high';
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    blocking: number;
    errors: number;
  };
  checks: Array<{
    checkId: string;
    adapter: string;
    status: 'passed' | 'failed' | 'error' | 'warning';
    severity: 'error' | 'warning' | 'info';
    blocking: boolean;
    message: string;
  }>;
}

export interface GuardHooksAPI {
  getStatus: (projectPath: string) => Promise<GuardHooksStatusData>;
  install: (projectPath: string) => Promise<GuardHooksInstallResultData>;
  uninstall: (projectPath: string) => Promise<{ ok: boolean; removed: string[] }>;
  listReports: (projectPath: string, limit?: number) => Promise<GuardReportRecordData[]>;
}

export interface FalsePositiveFeedbackItem {
  source: 'guard' | 'sentinel';
  ruleId: string;
  title?: string;
  message: string;
  severity?: string;
  file?: string;
  line?: number;
}

export interface FalsePositiveFeedbackRecord extends FalsePositiveFeedbackItem {
  id: string;
  timestamp: string;
}

export interface FeedbackAPI {
  reportFalsePositive: (projectPath: string, item: FalsePositiveFeedbackItem) => Promise<{ ok: boolean; id?: string; reason?: string }>;
  listFalsePositives: (projectPath: string, source?: 'guard' | 'sentinel') => Promise<FalsePositiveFeedbackRecord[]>;
}

/** 门禁配置（持久化到 .zhshield/guard-config.json） */
export interface GuardConfig {
  readonly enabled: boolean;
  readonly preCommit: boolean;
  readonly prePush: boolean;
  readonly blockOnCritical: boolean;
}

/** 门禁配置 API（IPC 桥接） */
export interface GuardConfigAPI {
  read: () => Promise<GuardConfig>;
  write: (config: GuardConfig) => Promise<void>;
}

export interface SchedulerStateData {
  jobs: Array<{
    id: string;
    config: Record<string, unknown>;
    nextRun: string;
    lastRun?: string;
    lastStatus?: 'success' | 'failure' | 'skipped';
    createdAt: string;
  }>;
}

export interface SchedulerAPI {
  readState: () => Promise<SchedulerStateData>;
  writeState: (state: SchedulerStateData) => Promise<void>;
}

export interface ElectronAPI {
  getAppInfo: () => Promise<{ name: string; version: string; platform: string; apiBase?: string }>;
  getToolAvailability?: () => Promise<Array<{ id: string; available: boolean }>>;
  /** 系统语言（Electron app.getLocale） */
  getLocale?: () => Promise<string>;
  /** 语言偏好同步到主进程（菜单/对话框/任务状态本地化） */
  setLanguage?: (lng: string) => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximized: (callback: (maximized: boolean) => void) => () => void;
  onPipelineProgress: (callback: (progress: PipelineProgress) => void) => () => void;
  platform: string;
  openFolderDialog: () => Promise<string | null>;
  loadProjects: () => Promise<Array<{ name: string; path: string }>>;
  saveProjects: (projects: Array<{ name: string; path: string }>) => Promise<void>;
  showSaveDialog: (options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }) => Promise<SaveDialogResult>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  ai?: AiAPI;
  sop: SopAPI;
  sync: SyncAPI;
  engine: EngineAPI;
  tasks: TaskAPI;
  guardHooks?: GuardHooksAPI;
  sentinel: SentinelAPI;
  evolve: EvolveAPI;
  backup?: BackupAPI;
  feedback?: FeedbackAPI;
  scheduler?: SchedulerAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
