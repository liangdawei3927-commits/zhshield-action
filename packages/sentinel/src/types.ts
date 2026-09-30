/** 事件在自动修复流水线中的生命周期状态（检测 → 派单 → 修复 → 验证 → 合并/部署，含人工接管与回滚） */
export type EventStatus =
  | 'detected'
  | 'assigned'
  | 'fixing'
  | 'pr_opened'
  | 'validating'
  | 'passed'
  | 'failed'
  | 'merged'
  | 'deployed'
  | 'rolled_back'
  | 'manual_taken_over';

/** 事件严重级别，p1 最高优先级 */
export type EventSeverity = 'p1' | 'p2' | 'p3';
/** 哨兵可采集/归类的事件类型 */
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

/** 哨兵事件实体：一次异常的上报记录，含去重键、验证结论、上下文与状态流转历史 */
export interface SentinelEvent {
  id: string;
  projectId: string;
  timestamp: Date;
  dedupeKey: string;
  title: string;
  service: string;
  module: string;
  severity: EventSeverity;
  status: EventStatus;
  validation: {
    status: 'pending' | 'pass' | 'fail';
    source?: string;
    summary?: string;
  };
  context: Record<string, unknown>;
  history: Array<{
    timestamp: Date;
    action: string;
    operator: string;
    detail: string;
  }>;
  occurrenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

/** 告警通知负载（Alertmanager 兼容结构），转发至各接收渠道 */
export interface AlertPayload {
  receiver: string;
  status: 'firing' | 'resolved';
  commonLabels: {
    alertname: string;
    service: string;
    module: string;
    severity: string;
    [key: string]: string;
  };
  commonAnnotations: {
    summary: string;
    description: string;
  };
  alerts: Array<{
    status: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    generatorURL?: string;
    fingerprint: string;
  }>;
}
