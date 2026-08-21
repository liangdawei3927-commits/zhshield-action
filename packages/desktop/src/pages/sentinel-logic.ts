import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import { getSentinelEvents, startSentinelMonitoring, type FalsePositiveFeedbackItem } from '../services/engineApi';
import { useFalsePositiveCount } from '../components/hooks/useFalsePositiveCount';
import type { AiFixIssue } from '../utils/copyToAi';

export interface SentinelEventItem {
  id: string;
  title: string;
  type: string;
  severity: string;
  source: string;
  status: string;
  occurrenceCount: number;
  lastSeen: string;
  location?: { file?: string; line?: number };
  diagnosis?: { suggestion?: string };
  context?: {
    request?: { method: string; path: string };
    location?: { module?: string; file?: string; line?: number; column?: number; snippet?: string };
    stack?: string;
    pattern?: string;
    matchedLine?: string;
  };
}

export const SEVERITY_CONFIG: Record<string, { textKey: string; color: string; bg: string }> = {
  critical: { textKey: 'severity.critical', color: 'rgb(var(--zh-danger-dark))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  high: { textKey: 'severity.high', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  medium: { textKey: 'severity.medium', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)' },
  low: { textKey: 'severity.low', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)' },
  info: { textKey: 'severity.info', color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-bg-secondary))' },
};

export const STATUS_CONFIG: Record<string, { textKey: string; color: string; bg: string }> = {
  detected: { textKey: 'status.detected', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.15)' },
  assigned: { textKey: 'status.assigned', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.15)' },
  fixing: { textKey: 'status.fixing', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.15)' },
  pr_opened: { textKey: 'status.pr_opened', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.15)' },
  validating: { textKey: 'status.validating', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.15)' },
  passed: { textKey: 'status.passed', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.15)' },
  failed: { textKey: 'status.failed', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.15)' },
  merged: { textKey: 'status.merged', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.15)' },
  deployed: { textKey: 'status.deployed', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.15)' },
  rolled_back: { textKey: 'status.rolled_back', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.15)' },
  manual_taken_over: { textKey: 'status.manual_taken_over', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.15)' },
};

/** 事件闭环阶段：发现 → 修复 → 验证 → 归档 */
export const EVENT_LIFECYCLE_STEPS = [
  { key: 'detect', labelKey: 'lifecycle.detect' },
  { key: 'fix', labelKey: 'lifecycle.fix' },
  { key: 'validate', labelKey: 'lifecycle.validate' },
  { key: 'archive', labelKey: 'lifecycle.archive' },
] as const;

export type LifecycleStage = (typeof EVENT_LIFECYCLE_STEPS)[number]['key'];

const STATUS_TO_STAGE: Record<string, LifecycleStage> = {
  detected: 'detect',
  assigned: 'fix',
  fixing: 'fix',
  pr_opened: 'fix',
  validating: 'validate',
  passed: 'archive',
  failed: 'validate',
  merged: 'archive',
  deployed: 'archive',
  rolled_back: 'archive',
  manual_taken_over: 'fix',
};

export function statusToStage(status: string): LifecycleStage {
  return STATUS_TO_STAGE[status] ?? 'detect';
}

export const TYPE_LABELS: Record<string, string> = {
  'runtime-exception': 'page.sentinel.type.runtimeException', 'http-error': 'page.sentinel.type.httpError',
  'performance-degradation': 'page.sentinel.type.performanceDegradation', 'crash': 'page.sentinel.type.crash',
  'frontend-error': 'page.sentinel.type.frontendError', 'white-screen': 'page.sentinel.type.whiteScreen',
  'security-incident': 'page.sentinel.type.securityIncident', 'memory-leak': 'page.sentinel.type.memoryLeak',
  'timeout': 'page.sentinel.type.timeout',
};

/** 监控开启后每 5s 轮询刷新事件 */
function useSentinelPolling(monitoring: boolean, refreshEvents: () => void): void {
  useEffect(() => {
    if (!monitoring) return;
    const timer = setInterval(() => {
      refreshEvents();
    }, 5000);
    return () => clearInterval(timer);
  }, [monitoring, refreshEvents]);
}

/** 事件列表数据：事件状态 + 刷新 */
function useSentinelEventData(onLoaded: () => void): {
  events: SentinelEventItem[];
  refreshEvents: () => void;
} {
  const [events, setEvents] = useState<SentinelEventItem[]>([]);

  const refreshEvents = useCallback(() => {
    getSentinelEvents()
      .then((data) => setEvents((data ?? []) as unknown as SentinelEventItem[]))
      .finally(onLoaded);
  }, [onLoaded]);

  return { events, refreshEvents };
}

/** 监控启停：监控状态 + 开启动作（挂载即自动启动，IPC 侧幂等） */
function useSentinelMonitoring(
  projectPath: string,
  refreshEvents: () => void,
): {
  monitoring: boolean;
  startMonitoring: () => Promise<void>;
} {
  const [monitoring, setMonitoring] = useState(false);

  const startMonitoring = useCallback(async () => {
    const result = await startSentinelMonitoring(projectPath);
    if (result.ok) {
      setMonitoring(true);
      await refreshEvents();
    }
  }, [projectPath, refreshEvents]);

  useEffect(() => {
    void startMonitoring();
  }, [startMonitoring]);

  return { monitoring, startMonitoring };
}

/** 事件列表状态：加载 + 监控启停 */
function useSentinelEvents(projectPath: string): {
  events: SentinelEventItem[];
  loading: boolean;
  monitoring: boolean;
  refreshEvents: () => void;
  startMonitoring: () => Promise<void>;
} {
  const [loading, setLoading] = useState(true);
  const markLoaded = useCallback(() => setLoading(false), []);
  const { events, refreshEvents } = useSentinelEventData(markLoaded);
  const { monitoring, startMonitoring } = useSentinelMonitoring(projectPath, refreshEvents);
  const startWithLoading = useSentinelStartWithLoading(startMonitoring, setLoading);

  useEffect(() => {
    refreshEvents();
  }, [refreshEvents]);

  useSentinelPolling(monitoring, refreshEvents);

  return { events, loading, monitoring, refreshEvents, startMonitoring: startWithLoading };
}

function useSentinelStartWithLoading(
  startMonitoring: () => Promise<void>,
  setLoading: (v: boolean) => void,
): () => Promise<void> {
  return useCallback(async () => {
    setLoading(true);
    try {
      await startMonitoring();
    } finally {
      setLoading(false);
    }
  }, [startMonitoring]);
}

/** 事件严重度 / 活跃状态统计 */
function countSentinelStats(events: SentinelEventItem[]): {
  criticalCount: number;
  highCount: number;
  activeCount: number;
} {
  const criticalCount = events.filter((e) => e.severity === 'critical').length;
  const highCount = events.filter((e) => e.severity === 'high').length;
  const activeCount = events.filter((e) => ['detected', 'assigned', 'fixing'].includes(e.status)).length;
  return { criticalCount, highCount, activeCount };
}

/** 按最后出现时间倒序排序 */
function sortSentinelEvents(events: SentinelEventItem[]): SentinelEventItem[] {
  return events.toSorted(
    (a: Readonly<SentinelEventItem>, b: Readonly<SentinelEventItem>) =>
      new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
  );
}

/** 误报反馈数量（按来源过滤，用于 KPI 卡展示） */
export function useSentinelPage(projectPath: string) {
  const { events, loading, monitoring, refreshEvents, startMonitoring } = useSentinelEvents(projectPath);
  const falsePositiveCount = useFalsePositiveCount(projectPath, 'sentinel');

  return {
    events,
    loading,
    monitoring,
    ...countSentinelStats(events),
    falsePositiveCount,
    sorted: sortSentinelEvents(events),
    refreshEvents,
    startMonitoring,
  };
}

/** 哨兵事件 → AI 修复问题（崩溃事件附带堆栈，便于 AI 定位根因） */
export function eventToAiFixIssue(event: SentinelEventItem): AiFixIssue {
  const ctx = event.context ?? {};
  const message = ctx.stack
    ? `${ctx.matchedLine ?? event.title}\n\n${t('page.sentinel.stackLabel')}:\n${ctx.stack.slice(0, 2000)}`
    : (ctx.matchedLine ?? event.title);
  return {
    source: t('page.sentinel.aiFixSource'),
    ruleId: ctx.pattern ?? event.type ?? 'sentinel-event',
    severity: event.severity,
    file: ctx.location?.file,
    line: ctx.location?.line,
    column: ctx.location?.column,
    message,
    suggestion: event.diagnosis?.suggestion,
  };
}

/** 哨兵事件 → 误报反馈条目（不携带规则内部细节，仅问题定位信息） */
export function eventToFalsePositiveItem(event: SentinelEventItem): FalsePositiveFeedbackItem {
  const ctx = event.context ?? {};
  return {
    source: 'sentinel',
    ruleId: ctx.pattern ?? event.type ?? 'sentinel-event',
    title: event.title,
    message: ctx.matchedLine ?? event.title,
    severity: event.severity,
    file: ctx.location?.file ?? event.location?.file,
    line: ctx.location?.line ?? event.location?.line,
  };
}
