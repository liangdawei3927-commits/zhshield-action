/// <reference types="vite/client" />

/**
 * 同步健康度快照（主进程 SopSyncScheduler 产出）
 *
 * everSucceeded 是关键字段：它把「从未接入云端」与「接入过但已过期」分开。
 * 没有它时，桌面端每次重启内存归零，一天的正常离线也会被显示成「严重过期」。
 */
export interface SopSyncHealth {
  /** 降级等级：0 正常 / 1-3 待更新 / 4 严重过期 */
  level: 0 | 1 | 2 | 3 | 4;
  /** 是否曾经成功同步过；false = 从未接入云端，而非过期 */
  everSucceeded: boolean;
  /** 最近一次成功同步的 ISO 时间 */
  lastSuccessAt: string | null;
  /** 最近一次尝试同步的 ISO 时间（无论成败） */
  lastAttemptAt: string | null;
  /** 最近一次失败原因原文；最近一次成功则为 null */
  lastError: string | null;
  /** 距最近一次成功同步的天数（含小数）；从未成功为 null */
  daysSinceSuccess: number | null;
  /** lastError 的语义分类：none/network/compatibility/signature/unknown */
  failureKind: 'none' | 'network' | 'compatibility' | 'signature' | 'unknown';
}

/** SOP 规则中心 API（主进程 IPC 桥接）：版本查询、规则同步、统计与应急更新 */
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
  getSyncHealth: () => Promise<SopSyncHealth>;
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
    status: 'pass' | 'warn' | 'fail' | 'attention' | 'info';
    detail: string;
    category?: string;
    /** 来源引擎/适配器标识（如 'ai-code-review' / 'semgrep' / 'eslint'） */
    source?: string;
  }>;
  metadata: {
    duration: number;
    timestamp: string;
  };
  /**
   * 数据覆盖度（缺省 = full，向后兼容）。
   * - full：本次完整扫描，checks 含通过项与未检测项；
   * - issues-only：读自历史落盘快照（`domains/<source>.json`），**仅含问题项**，
   *   通过项不落盘 → UI 不得据此宣称「通过数/通过率」。
   */
  coverage?: 'full' | 'issues-only';
}

/** 诊断来源（按域快照落盘键，与主进程 DiagnosticSource 对齐） */
export type DomainReportSource =
  | 'guard'
  | 'inspect'
  | 'refactor'
  | 'deps'
  | 'techdebt'
  | 'security'
  | 'performance';

/**
 * 按域落盘快照的渲染侧镜像（`.zhshield/diagnostics/domains/<source>.json`）。
 * 只含问题条目（通过项不落盘），用于「有历史评分即可查看详情」的场景。
 */
export interface DomainReportSnapshot {
  generatedAt: string;
  summary: { total: number; error: number; warning: number; info: number };
  issues: Array<{
    ruleId: string;
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    file: string;
    line?: number;
    column?: number;
    suggestion?: string;
    autoFixable: boolean;
    source: string;
    fingerprint: string;
  }>;
  dimensionScore?: {
    dimension: 'quality';
    score: number;
    issues: number;
    status: 'scored' | 'not-run';
    version?: number;
  };
}

/**
 * 一次域扫描的历史摘要（渲染侧镜像，`.zhshield/history/<domain>.jsonl` 的一行）。
 *
 * 与 `DomainReportSnapshot` 的区别：快照是「最近一次」的覆盖写，本类型是「每一次」。
 * 指纹集已由主进程解压（写入时的 `sameAs` 指针补齐），可直接与上一条做 diff。
 */
export interface DomainScanRecordData {
  scanId: string;
  domain: string;
  /** 该次扫描的时间（快照 generatedAt） */
  scannedAt: string;
  /** 记录写入时间（补写旧快照时会晚于 scannedAt） */
  recordedAt: string;
  /** 该域分数；该域当时不出分则为 null（不是 0 分） */
  score: number | null;
  scoreVersion?: number;
  total: number;
  error: number;
  warning: number;
  info: number;
  /** false = 该域问题不带严重级别（如垃圾清理），error/warning/info 恒为 0，不可推断为「都是 info」 */
  severityApplicable?: boolean;
  esloc?: number;
  /** 相对项目根的指纹集（绝对路径前缀已剥离，换目录/换机仍可比） */
  fingerprints: string[];
  fingerprintsHash: string;
  sameAs?: string;
  coverage?: { files?: number; skipped?: number };
  /** 明细 blob 名；null/缺省 = 本次未保存明细 */
  blob?: string | null;
  /**
   * true = 由「最近一次快照」临时回填（升级前的数据，无逐次历史）。
   * 这类记录只读、不落盘，用于让上次检查时间立刻可见。
   */
  backfilled?: boolean;
}

/** 某次扫描的明细（L3）：只在该次指纹集发生变化时落盘 */
export interface DomainScanBlobData {
  scanId: string;
  domain: string;
  scannedAt: string;
  entries: Array<{
    ruleId: string;
    severity: 'error' | 'warning' | 'info';
    category: string;
    message: string;
    file: string;
    line?: number;
    column?: number;
    suggestion?: string;
    autoFixable: boolean;
    source: string;
    fingerprint: string;
  }>;
}

/** @zh/security SecurityScanReport shape (serializable)。
 *  垃圾清单已迁至 GarbageScanReportData（垃圾 ≠ 安全，T5 各司其职）。 */
export interface SecurityScanReportData {
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    malwareTotal: number;
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
  securityScore: number;
  metadata: {
    duration: number;
    timestamp: string;
  };
}

/**
 * 垃圾清理扫描报告（垃圾清理域自有通道，@zh/garbage GarbageScanReport 的序列化形态）。
 * 不再寄生在 SecurityScanReportData 上。
 */
export interface GarbageScanReportData {
  projectPath: string;
  items: Array<{
    id: string;
    type: string;
    path: string;
    size: number;
    reason: string;
  }>;
  summary: {
    total: number;
    /** 可释放字节数（构建产物 / 垃圾文件） */
    size: number;
    byType: Record<string, number>;
  };
  /** 各检测项执行状态：ran=false 表示该项未真正执行（工具不可用/规则空跑） */
  checks: Array<{
    ruleId: string;
    name: string;
    ran: boolean;
    producer: 'detector' | 'sop-rule';
    reason?: string;
  }>;
  /** 未真正执行的检测项数 */
  skipped: number;
  timestamp: string;
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
    /**
     * 维度检测状态：`not-run` = 该域从未运行（`score` 恒为 0 且**不参与**总分加权）。
     * 缺省视作已检测。与 `@zh/scoring` 的 `DimensionScore.status?` 同源 ——
     * 主进程 `toHealthScoreData` 整体透传 dimensions，故运行时该字段是存在的；
     * 此处漏声明曾导致渲染层读不到，把「未检测」显示成「0 分 · 危险」。
     */
    status?: 'scored' | 'not-run';
  }>;
  summary: string;
  timestamp: string;
  /** 评分算法版本（2 = 十域聚合 + 红线封顶）；跨版本分数不做直接对比 */
  scoreVersion?: number;
  /** 红线封顶：本次汇总存在 critical 事实时总评被压制的原因 */
  redLine?: {
    capped: boolean;
    cap: number;
    reasons: Array<{ domain: string; kind: string; count: number }>;
  };
}

/** 项目画像（可序列化子集，供前端列出模块用于模块级评分） */
export interface ModuleProfileData {
  /**
   * 模块**绝对路径**（主进程已解析，与 `scores.project_id` 同源）。
   * 不要拿它当相对路径拼 URL 或做前缀匹配；画像原始相对值只在主进程内部使用。
   */
  path: string;
  type: string;
}
/** 项目画像（可序列化形态；模块明细见 {@link ModuleProfileData}） */
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
      location: {
        filePath: string;
        line: number;
        column: number;
        endLine: number;
        endColumn: number;
      };
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

/** 一键体检流水线结果（serializable；各阶段报告按需挂在对应字段上，未跑阶段为 undefined） */
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

/** 分类页实时评分（引擎在检查落盘时用 @zh/scoring 统一计算；渲染层只读不算） */
export interface DomainScoreData {
  /** 对应 @zh/scoring 的评分维度（当前仅 inspect → quality） */
  dimension: string;
  /** 0-100 */
  score: number;
  /** 计分所依据的问题条数 */
  issues: number;
  status: 'scored' | 'not-run';
  /** 快照生成时间（ISO 8601，即本次检查完成时间） */
  generatedAt: string;
  /** 上一轮检查的分数（覆盖写前从旧快照抢救；无基线时缺省） */
  previousScore?: { score: number; generatedAt: string };
}

/**
 * 参与总分的 10 个评分维度（与 @zh/scoring 的 DIMENSION_CATEGORIES 键一致）。
 * 源类型定义在 src/pages/domain-score-logic.ts（ScoreDimension），此处内联以保持
 * electron.d.ts 作为共享契约文件自包含（主进程 / 渲染层均可引用）。
 */
export type ScoreDimension =
  | 'quality'
  | 'gate'
  | 'security'
  | 'dependencies'
  | 'techdebt'
  | 'refactor'
  | 'performance'
  | 'sentinel'
  | 'garbage'
  | 'backup';

/** 依赖管家显式重锁基线的结果 */
export interface DepsRelockResult {
  ok: boolean;
  error?: string;
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

/** 检测引擎 API（主进程 IPC 桥接）：各域扫描/执行入口、评分读取与汇总报告生成 */
export interface EngineAPI {
  runGuard: (projectPath: string, options?: Record<string, unknown>) => Promise<GuardReportData>;
  runSecurity: (projectPath: string) => Promise<SecurityScanReportData>;
  runGarbageScan: (projectPath: string) => Promise<GarbageScanReportData>;
  cleanGarbage: (
    projectPath: string,
    items: Array<{ id: string; path: string; size: number; type: string }>,
  ) => Promise<GarbageCleanResultData>;
  restoreGarbage: (projectPath: string, batchId: string) => Promise<GarbageRestoreResultData>;
  runPerformance: (projectPath: string) => Promise<PerformanceReportData>;
  runRefactor: (projectPath: string) => Promise<RefactorReportData>;
  runDeps: (projectPath: string) => Promise<DependencyReportData>;
  depsRelockBaseline: (projectPath: string) => Promise<DepsRelockResult>;
  runTechDebt: (projectPath: string) => Promise<TechDebtReportData>;
  planDebtRepayment: (
    projectPath: string,
    actionId: string,
    opts?: { sprint?: string; gate?: 'allow-with-record' },
  ) => Promise<void>;
  verifyDebtRepaid: (projectPath: string, actionId: string) => Promise<boolean>;
  dismissDebtAction: (projectPath: string, actionId: string) => Promise<void>;
  runSecrets: (projectPath: string) => Promise<SecretReportData>;
  markSecretRotating: (secretId: string) => Promise<void>;
  verifySecretRotated: (secretId: string) => Promise<boolean>;
  dismissSecret: (secretId: string, reason: string) => Promise<void>;
  getScore: (projectId: string) => Promise<HealthScoreData | null>;
  getScoreHistory: (projectId: string) => Promise<HealthScoreData[]>;
  /** 分类页实时评分：读该域最近一次检查落盘的按域快照自带评分（跑完即有，无需手动汇总） */
  getDomainScore: (
    projectPath: string,
    dimension: ScoreDimension,
  ) => Promise<DomainScoreData | null>;
  /** 读该域最近一次落盘快照（仅问题项）；无快照/损坏返回 null，UI 据此决定是否可查看详情 */
  getDomainReport: (
    projectPath: string,
    source: DomainReportSource,
  ) => Promise<DomainReportSnapshot | null>;
  /** 某域完整报告落盘（扫描成功后调用）：详情页可原样回看上次结果 */
  saveDomainReport: (projectPath: string, domain: string, report: unknown) => Promise<boolean>;
  /** 读回某域最近一次完整报告；不存在/损坏返回 null */
  getSavedDomainReport: (projectPath: string, domain: string) => Promise<unknown | null>;
  /**
   * 原样读回归一化快照（`diagnostics/domains/<domain>.json`），不做结构校验。
   * 旧数据（无完整报告）唯一可回看的内容来源；渲染层按实际字段展示。
   */
  getDomainSnapshotRaw: (projectPath: string, domain: string) => Promise<unknown | null>;
  /**
   * 该域是否跑过（完整报告 or 归一化快照任一存在）。
   * 「详情入口」与「详情视图」共用同一判据：有结果才给按钮，避免亮着却点进空态。
   */
  hasDomainResult: (projectPath: string, domain: string) => Promise<boolean>;
  /**
   * 某域扫描历史（新 → 旧）。每次扫描一条，含分数 / 问题数 / severity 分布 / 指纹集。
   * 用于「这次比上次涨了还是跌了」与趋势回溯；无历史返回空数组。
   */
  listDomainHistory: (
    projectPath: string,
    domain: string,
    limit?: number,
  ) => Promise<DomainScanRecordData[]>;
  /** 某次扫描的明细；该次未保存明细或文件损坏 → null */
  getDomainScanBlob: (projectPath: string, blob: string) => Promise<DomainScanBlobData | null>;
  /** 某域最近一次扫描记录（供分类页显示「上次检查 · 时间」）；无历史 → null */
  getLatestDomainScan: (projectPath: string, domain: string) => Promise<DomainScanRecordData | null>;
  getProfile: (projectPath: string) => Promise<ProjectProfileData | null>;
  runPipeline: (
    projectPath: string,
    options?: { dryRun?: boolean; sop?: boolean; presetName?: string },
  ) => Promise<PipelineReportData>;
  runProfile: (
    projectPath: string,
  ) => Promise<{ profile: unknown; questions: unknown; drift: unknown }>;
  /** 汇总生成报告：只读各域最新结果并落库；无任何结果时为 null */
  generateReportSummary: (projectPath: string) => Promise<HealthScoreData | null>;
}

/** 工具规则同步 API（主进程 IPC 桥接）：规则拉取、一致性校验、状态查询与经验提交 */
export interface SyncAPI {
  syncRules: () => Promise<unknown[]>;
  resolveRules: () => Promise<{
    ok: boolean;
    reason?: string;
    total: number;
    changed: string[];
    missing: string[];
    shaMismatch: string[];
    unexpected: string[];
    healed: boolean;
  }>;
  getRulesStatus: () => Promise<
    Array<{ toolId: string; localVersion: string | null; stale: boolean }>
  >;
  emergencyUpdate: (toolId: string) => Promise<unknown>;
  submitExperience: (
    records: unknown[],
  ) => Promise<{ sent: number; queued: number; failed: number }>;
  getQueueStatus: () => Promise<{ queueLength: number }>;
}

/** 外部工具可用性 API（主进程 IPC 桥接）：工具状态查询与安装 */
export interface ToolsAPI {
  status: (projectPath?: string) => Promise<{
    source: 'cloud' | 'local';
    tools: Array<{ toolId: string; status: 'project' | 'path' | 'shared' | 'missing'; bin: string | null }>;
  }>;
  install: (toolIds: string[]) => Promise<{
    ok: boolean;
    reason?: 'packaged' | 'script_error';
    output: string;
  }>;
}

/** 哨兵事件查询条件：与 server 端 GET /system/sentinel/event-center 的查询参数同名同义 */
export interface SentinelEventQuery {
  readonly status?: string;
  readonly severity?: string;
  /** true 时排除不含可执行语义的通知类事件（进程生命周期、文件新增与内容变更） */
  readonly excludeInformational?: boolean;
}

/** 哨兵（持续监控）API（主进程 IPC 桥接）：事件读取、单条查询与监控启停 */
export interface SentinelAPI {
  getEvents: (options?: SentinelEventQuery) => Promise<SentinelEvent[]>;
  getEvent: (id: string) => Promise<SentinelEvent | undefined>;
  startMonitoring: (
    projectId: string,
    projectPath: string,
  ) => Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }>;
  getState: () => Promise<{ enabled: boolean }>;
  setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
}

/** 规则调优建议（来自 @zh/evolve，serializable） */
export interface SuggestionData {
  ruleId: string;
  message: string;
  confidence: number;
  source: string;
}

/** 规则权重（来自 @zh/evolve，serializable：权重、误报率与样本量） */
export interface RuleWeightData {
  ruleId: string;
  weight: number;
  falsePositiveRate: number;
  totalSamples: number;
  lastAdjustedAt: string;
}

/** 自进化 API（主进程 IPC 桥接）：建议、经验记录、权重读取与自动调权 */
export interface EvolveAPI {
  getSuggestions: (projectId: string) => Promise<SuggestionData[]>;
  listExperiences: (projectId: string) => Promise<unknown[]>;
  getRuleWeights: () => Promise<RuleWeightData[]>;
  recordExperience: (entry: unknown) => Promise<unknown>;
  autoAdjustWeights: () => Promise<RuleWeightData[]>;
}

/** 备份记录（serializable；CLI/桌面/HTTP 三端共享的落库行，云端/GitHub/本地产物信息按存在情况填充） */
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

/** 单次备份执行结果（serializable；results 逐通道列出成败与各通道特有字段） */
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

/** 备份配置（serializable；云端 / GitHub / 本地三通道开关与参数 + 调度计划） */
export interface BackupConfigData {
  cloud: { enabled: boolean; serverUrl: string; [key: string]: unknown };
  github: { enabled: boolean; owner: string; repo: string; [key: string]: unknown };
  local: { enabled: boolean; backupDir: string; [key: string]: unknown };
  schedule: {
    enabled: boolean;
    frequency: string;
    time: string;
    dayOfWeek?: number; // 0=Sun, weekly（对齐 kernel BackupSchedule）
    dayOfMonth?: number; // monthly（对齐 kernel BackupSchedule）
    [key: string]: unknown;
  };
}

/** 主进程推送的备份进度事件（kernel BACKUP_EVENTS payload） */
export interface BackupProgressData {
  projectId: string;
  backupId: string;
  phase: string;
  percent: number;
  message: string;
}

/** 备份 API（主进程 IPC 桥接）：执行备份、记录管理、配置读写与进度/完成事件订阅 */
export interface BackupAPI {
  executeBackup: (projectPath: string, trigger?: string) => Promise<BackupResultData>;
  getRecords: (projectId?: string) => Promise<BackupRecordData[]>;
  getRecord: (recordId: string) => Promise<BackupRecordData | null>;
  deleteRecord: (recordId: string) => Promise<boolean>;
  getConfig: (projectPath: string) => Promise<BackupConfigData>;
  saveConfig: (projectPath: string, config: BackupConfigData) => Promise<void>;
  authorizeGitHub: () => Promise<boolean>;
  openFolder: (projectPath: string, folderPath: string) => Promise<boolean>;
  onProgress: (callback: (payload: BackupProgressData) => void) => () => void;
  onCompleted: (callback: (payload: unknown) => void) => () => void;
  onFailed: (callback: (payload: unknown) => void) => () => void;
  onRecordsUpdated: (callback: (payload: unknown) => void) => () => void;
}

/** 流水线进度（主进程 → 渲染进程的推送事件载荷：当前阶段、提示文案与 0.0~1.0 进度） */
export interface PipelineProgress {
  stage: string;
  message: string;
  progress: number; // 0.0 ~ 1.0
}

/** 任务类型：对应各引擎检查（360 卫士式多任务并发） */
export type TaskKind =
  | 'pipeline' // 一键体检（流水线）
  | 'inspect' // 质量巡检
  | 'security' // 安全扫描（漏洞 + 恶意代码 + 密钥）
  | 'garbage' // 垃圾清理扫描
  | 'garbageClean' // 垃圾清理（移入回收站）
  | 'garbageRestore' // 回收站恢复
  | 'performance' // 优化加速
  | 'guard' // 门禁扫描
  | 'refactor' // 代码重构
  | 'deps' // 依赖管家（依赖图 / 许可证 / 投毒 / 锁文件）
  | 'techdebt'; // 技术债盘点

/** 任务状态（主进程任务注册表中的生命周期状态） */
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

/** 任务 API（主进程 IPC 桥接）：启动/列举/取消任务与任务变更事件订阅 */
export interface TaskAPI {
  start: (
    kind: TaskKind,
    projectPath: string,
    options?: Record<string, unknown>,
  ) => Promise<TaskInfo>;
  list: () => Promise<TaskInfo[]>;
  cancel: (id: string) => Promise<boolean>;
  onChanged: (callback: (task: TaskInfo) => void) => () => void;
}

/** AI 工具配置（可序列化形态：单个工具的启停、驱动方式 linter|cli 与配置文件路径） */
export interface AiToolConfigData {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'linter' | 'cli';
  configFile: string;
}

/** AI 配置写入单个项目的结果（可序列化：受影响文件清单与失败原因） */
export interface AiProjectWriteResultData {
  path: string;
  ok: boolean;
  error?: string;
  files: string[];
}

/** AI 配置批量应用结果（可序列化：是否已落盘 + 各项目逐项结果） */
export interface AiApplyResultData {
  saved: boolean;
  projects: AiProjectWriteResultData[];
}

/** AI 工具配置 API（主进程 IPC 桥接）：读取与保存 AI 工具配置 */
export interface AiAPI {
  loadConfig: () => Promise<AiToolConfigData>;
  saveConfig: (config: AiToolConfigData, projectPaths: string[]) => Promise<AiApplyResultData>;
}

/** Git hooks 门禁状态（可序列化：是否存在 .git 与已安装的 hook 清单） */
export interface GuardHooksStatusData {
  hasGitDir: boolean;
  installed: string[];
}

/** Git hooks 门禁安装结果（可序列化：成功安装的 hook、跳过的 hook 与跳过原因） */
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

/** Git hooks 门禁 API（主进程 IPC 桥接）：状态查询、安装/卸载与历史门禁报告列表 */
export interface GuardHooksAPI {
  getStatus: (projectPath: string) => Promise<GuardHooksStatusData>;
  install: (projectPath: string) => Promise<GuardHooksInstallResultData>;
  uninstall: (projectPath: string) => Promise<{ ok: boolean; removed: string[] }>;
  listReports: (projectPath: string, limit?: number) => Promise<GuardReportRecordData[]>;
}

/** 误报反馈条目（渲染进程提交的误报描述：来源域、规则 ID、位置与说明） */
export interface FalsePositiveFeedbackItem {
  source: 'guard' | 'sentinel';
  ruleId: string;
  title?: string;
  message: string;
  severity?: string;
  file?: string;
  line?: number;
}

/** 误报反馈落库记录（在 {@link FalsePositiveFeedbackItem} 基础上补记录 ID 与提交时间） */
export interface FalsePositiveFeedbackRecord extends FalsePositiveFeedbackItem {
  id: string;
  timestamp: string;
}

/** 误报反馈 API（主进程 IPC 桥接）：提交误报与按来源域查询历史记录 */
export interface FeedbackAPI {
  reportFalsePositive: (
    projectPath: string,
    item: FalsePositiveFeedbackItem,
  ) => Promise<{ ok: boolean; id?: string; reason?: string }>;
  listFalsePositives: (
    projectPath: string,
    source?: 'guard' | 'sentinel',
  ) => Promise<FalsePositiveFeedbackRecord[]>;
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

/** 调度器状态（可序列化；落盘持久化各定时任务配置与最近一次执行结果） */
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

/** 调度器状态 API（主进程 IPC 桥接）：读写定时任务状态 */
export interface SchedulerAPI {
  readState: () => Promise<SchedulerStateData>;
  writeState: (state: SchedulerStateData) => Promise<void>;
}

/** 测试专用观测 API（仅 e2e 门控注册，生产不暴露） */
export interface E2eObservationAPI {
  /** 统计某 project_id 在 5 表中已软删（deleted_at IS NOT NULL）的行数（逐表） */
  countSoftDeletedData: (projectPath: string) => Promise<Record<string, number>>;
  /** 统计某 project_id 在 5 表中的总行数（含未软删，供预置断言对照） */
  countTotalData: (projectPath: string) => Promise<Record<string, number>>;
  /** 返回当前画像缓存归属的项目路径（null = 已清空） */
  getCachedProfileProjectPath: () => Promise<string | null>;
  /** 预置画像缓存归属某项目（供删除后断言清空） */
  setCachedProfile: (projectPath: string) => Promise<void>;
  /** 预置 5 表孤儿行（project_id = projectPath，与桌面写入键控对齐） */
  seedOrphanData: (projectPath: string) => Promise<void>;
}

/** 渲染进程可用的 window.electronAPI 全量契约（由主进程 preload 注入；带 ? 的子域仅在启用时注册） */
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
  removeProject: (projectPath: string) => Promise<{ ok: boolean }>;
  showSaveDialog: (options: {
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<SaveDialogResult>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  ai?: AiAPI;
  sop: SopAPI;
  sync: SyncAPI;
  tools: ToolsAPI;
  engine: EngineAPI;
  tasks: TaskAPI;
  guardHooks?: GuardHooksAPI;
  guardConfig?: GuardConfigAPI;
  sentinel: SentinelAPI;
  evolve: EvolveAPI;
  backup?: BackupAPI;
  feedback?: FeedbackAPI;
  scheduler?: SchedulerAPI;
  /** 测试专用观测（仅 e2e 门控注册，生产不暴露；供删除全链用例观测主进程内存态） */
  e2e?: E2eObservationAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** Electron 无边框窗口拖拽区域（-webkit-app-region）在 React CSSProperties 中的类型补充 */
declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag' | 'none';
  }
}

export {};
