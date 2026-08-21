import type { HealthScore, ToolId, ToolStatus } from './types';

/**
 * 治理引擎事件定义 (文档 11.1 节)
 *
 * 各模块完成扫描/检查后，emit 事件供其他模块消费。
 */

export type GuardStage = 'pre-commit' | 'pre-push' | 'ci';

export interface ToolExecutedEvent {
  tool: ToolId;
  status: ToolStatus;
  duration: number;
  issueCount: number;
  projectId: string;
  timestamp: Date;
}

export interface ScanCompletedEvent {
  module: 'inspect' | 'security';
  projectId: string;
  duration: number;
  totalIssues: number;
  issueCategories: Record<string, number>;
  timestamp: Date;
}

export interface GuardCheckRequestedEvent {
  stage: GuardStage;
  projectId: string;
  changedFiles: string[];
  timestamp: Date;
}

export interface GuardCheckCompletedEvent {
  stage: GuardStage;
  projectId: string;
  passed: boolean;
  blockedFiles: string[];
  issueCount: number;
  duration: number;
  timestamp: Date;
}

/**
 * 所有治理引擎事件的联合类型
 */
export type GovernanceEvent =
  | { type: 'tool:executed'; payload: ToolExecutedEvent }
  | { type: 'scan:completed'; payload: ScanCompletedEvent }
  | { type: 'guard:check-requested'; payload: GuardCheckRequestedEvent }
  | { type: 'guard:check-completed'; payload: GuardCheckCompletedEvent };

/**
 * 最小事件发射器接口 — 各引擎依赖此接口而非直接依赖 EventBus 实现
 */
export interface EventEmitter {
  emit(event: GovernanceEvent): void | Promise<void>;
}

/**
 * 空发射器（默认值，不产生副作用）
 */
export const NOOP_EMITTER: EventEmitter = {
  emit() {
    /* noop */
  },
};

/**
 * 内核规则引擎报告（结构化类型，与 @zh/kernel 的 RuleEngineReport 结构兼容）。
 * 定义在此处避免 shared → kernel 循环依赖。
 */
export interface KernelRuleEngineReport {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  ok: boolean | null;
  evaluations: unknown[];
  durationMs: number;
  timestamp: Date;
}

/**
 * SOP 规则变更事件（结构化类型，与 @zh/kernel 的 RuleChangeEvent 结构兼容）。
 */
export interface KernelRuleChangeEvent {
  type: 'added' | 'removed' | 'modified' | 'status-changed';
  ruleId: string;
  rule?: unknown;
  previousStatus?: string;
  timestamp: Date;
}

/**
 * KernelEventMap — EventBus<Events> 的默认泛型参数。
 * 将所有已知事件名称映射到其 payload 类型，提供编译期类型安全。
 */
export interface KernelEventMap {
  'rule-engine:evaluated': KernelRuleEngineReport;
  'sop:rule-changed': KernelRuleChangeEvent;
  'sop:cache-synced': {
    type: string;
    fromVersion?: string;
    toVersion: string;
    ruleCount: number;
    timestamp: Date;
  };
  'sop:emergency-updated': {
    count: number;
    ruleIds: string[];
    timestamp: Date;
  };

  'tool:executed': ToolExecutedEvent;
  'scan:completed': ScanCompletedEvent;
  'guard:check-requested': GuardCheckRequestedEvent;
  'guard:check-completed': GuardCheckCompletedEvent;

  'backup:request': Record<string, never>;
  'backup:started': {
    projectId: string;
    backupId: string;
    type: string;
  };
  'backup:progress': {
    projectId: string;
    backupId: string;
    phase: string;
    percent: number;
    message: string;
  };
  'backup:completed': {
    projectId: string;
    backupId: string;
    result: unknown;
  };
  'backup:failed': {
    projectId: string;
    backupId: string;
    error: string;
    partialResult?: unknown;
  };
  'backup:config-updated': Record<string, never>;
  'backup:list-records': Record<string, never>;
  'backup:get-detail': Record<string, never>;
  'backup:delete-record': Record<string, never>;

  'score:calculated': HealthScore;

  'profile:confirmed': { projectPath: string; profile: unknown };
}
