import type { ToolId, ToolStatus } from './types';

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
