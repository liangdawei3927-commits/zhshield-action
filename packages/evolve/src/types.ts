/** 经验类型：真实命中 / 误报 / 已修复 / 最佳实践（决定经验对规则权重的调节方向） */
export type ExperienceType = 'true-positive' | 'false-positive' | 'fix-applied' | 'best-practice';

/** 规则状态：生效中 / 已废弃 / 试验中 / 已晋级（试验与晋级供灰度放量使用） */
export type RuleState = 'active' | 'deprecated' | 'experimental' | 'promoted';

/** 经验条目：一次命中/误报/修复的结构化记录，是自进化与跨端同步的最小单元 */
export interface ExperienceEntry {
  id: string;
  projectId: string;
  type: ExperienceType;
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

/** 规则状态变更记录：谁在何时因何把某条规则切到目标状态（供同步与审计） */
export interface RuleStateEntry {
  ruleId: string;
  state: RuleState;
  reason: string;
  changedAt: Date;
  changedBy: string;
}

/** 规则权重条目：当前权重、历史误报率、累计样本量与最近一次自动调权时刻 */
export interface RuleWeightEntry {
  ruleId: string;
  weight: number;
  falsePositiveRate: number;
  totalSamples: number;
  lastAdjustedAt: Date;
}

/** 调优建议：针对某条规则给出的改进建议（文案、置信度与来源） */
export interface Suggestion {
  ruleId: string;
  message: string;
  confidence: number;
  source: string;
}

/** 同步载荷：客户端上传的权重与规则状态快照（clientId 用于服务端幂等与归属） */
export interface SyncPayload {
  clientId: string;
  syncedAt: string;
  weights: RuleWeightEntry[];
  ruleStates: RuleStateEntry[];
  totalSynced: number;
}
