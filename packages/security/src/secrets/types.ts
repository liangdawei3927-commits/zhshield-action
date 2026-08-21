// @zh/security secrets — 密钥全生命周期数据模型（附 C 契约）

/** 密钥类型（gitleaks RuleID → 归一化类型） */
export type SecretType =
  | 'aws-access-key'
  | 'aws-secret-key'
  | 'github-token'
  | 'gitlab-token'
  | 'database-password'
  | 'redis-password'
  | 'private-key'
  | 'stripe-key'
  | 'twilio-key'
  | 'jwt-token'
  | 'alibaba-cloud-access-key'
  | 'tencent-cloud-secret-id'
  | 'tencent-cloud-secret-key'
  | 'huawei-cloud-access-key'
  | 'huawei-cloud-secret-key'
  | 'google-cloud-service-account'
  | 'azure-storage-account-key'
  | 'npm-token'
  | 'pypi-token'
  | 'dockerhub-token'
  | 'slack-webhook-url'
  | 'discord-webhook-url'
  | 'telegram-bot-token'
  | 'generic-api-key';

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * 密钥生命周期状态（附 C.2）：
 * - active    = 未处理
 * - rotating  = 用户标记正在轮换（门禁对此类放行并记录）
 * - rotated   = 用户确认已轮换 → 触发复核扫描
 * - dismissed = 复核通过 / 误报 → 记入经验池，不再告警
 */
export type SecretStatus = 'active' | 'rotating' | 'rotated' | 'dismissed';

export interface SecretLocation {
  file: string;
  line: number;
  /** 引入提交 hash（history 模式来自 gitleaks Commit；工作区模式尽力解析，未知为空） */
  commit: string;
  branch?: string;
}

export interface SecretFinding {
  /** 确定性标识 = sha256(值) 十六进制，明文不落盘 */
  secretId: string;
  type: SecretType;
  /** 脱敏值：仅前 4 + 后 4 位可见 */
  displayValue: string;
  location: SecretLocation;
  /** 引入时间 ISO（history 模式为 gitleaks Date；工作区模式为文件首次提交时间，未知为空） */
  introducedAt: string;
  /** 代码中是否仍引用（活跃度，优先级排序依据） */
  stillReferenced: boolean;
  /** 本地 git remote 配置判断（边界 2：不声称已被爬取） */
  pushedToRemote: boolean;
  /** remote URL 为公共仓库形态（github/gitlab/bitbucket/gitee 等公开托管） */
  remotePublic: boolean;
  severity: SecretSeverity;
  status: SecretStatus;
}

export interface SecretScanReport {
  findings: SecretFinding[];
  summary: {
    total: number;
    critical: number;
    active: number;
    /** 仅历史中存在（工作区已删但 git 历史还在） */
    historyFound: number;
  };
  /** 增量扫描断点（history 模式 = 当前 HEAD；工作区模式 = 不变） */
  lastScannedCommit: string;
}

/** 持久化状态单条记录（状态机 + 复核语义，不存明文） */
export interface SecretStateRecord {
  status: SecretStatus;
  /** dismissed 原因（经验池消费） */
  reason?: string;
  /** 最近一次状态变更时间 ISO */
  updatedAt: string;
}

/** 状态文件结构（.zhshield/secrets-state.json），key = secretId */
export interface SecretPersistState {
  lastScannedCommit: string;
  secrets: Record<string, SecretStateRecord>;
}

/** 命令执行抽象（可注入 mock，便于测试） */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ): Promise<{ stdout: string }>;
}
