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

export type EventSeverity = 'p1' | 'p2' | 'p3';
export type EventType = 'runtime-exception' | 'http-error' | 'performance-degradation'
  | 'crash' | 'frontend-error' | 'white-screen' | 'security-incident'
  | 'memory-leak' | 'timeout';

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
