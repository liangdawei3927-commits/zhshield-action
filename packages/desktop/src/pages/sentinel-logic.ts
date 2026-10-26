import { useCallback, useEffect, useState } from 'react';
import { t } from '@zh/i18n';
import type { SentinelEvent } from '@zh/sentinel';
import {
  getSentinelEvents,
  startSentinelMonitoring,
  stopSentinelMonitoring,
  getSentinelState,
  type FalsePositiveFeedbackItem,
} from '../services/engineApi';
import { useFalsePositiveCount } from '../components/hooks/useFalsePositiveCount';
import type { AiFixIssue } from '../utils/copyToAi';
import { useLoadingAction } from '../hooks/useLoadingAction';
import { SEVERITY_STYLES } from './severity-styles';

/** 哨兵事件展示条目：事件元信息 + 定位/诊断/上下文证据 */
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
  critical: {
    textKey: 'severity.critical',
    color: 'rgb(var(--zh-danger-dark))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
  },
  ...SEVERITY_STYLES,
  info: {
    textKey: 'severity.info',
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-bg-secondary))',
  },
};

export const STATUS_CONFIG: Record<string, { textKey: string; color: string; bg: string }> = {
  detected: {
    textKey: 'status.detected',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.15)',
  },
  assigned: {
    textKey: 'status.assigned',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.15)',
  },
  fixing: {
    textKey: 'status.fixing',
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.15)',
  },
  pr_opened: {
    textKey: 'status.pr_opened',
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.15)',
  },
  validating: {
    textKey: 'status.validating',
    color: 'rgb(var(--zh-info))',
    bg: 'rgb(var(--zh-info) / 0.15)',
  },
  passed: {
    textKey: 'status.passed',
    color: 'rgb(var(--zh-success))',
    bg: 'rgb(var(--zh-success) / 0.15)',
  },
  failed: {
    textKey: 'status.failed',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.15)',
  },
  merged: {
    textKey: 'status.merged',
    color: 'rgb(var(--zh-success))',
    bg: 'rgb(var(--zh-success) / 0.15)',
  },
  deployed: {
    textKey: 'status.deployed',
    color: 'rgb(var(--zh-success))',
    bg: 'rgb(var(--zh-success) / 0.15)',
  },
  rolled_back: {
    textKey: 'status.rolled_back',
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.15)',
  },
  manual_taken_over: {
    textKey: 'status.manual_taken_over',
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.15)',
  },
};

/** 事件闭环阶段：发现 → 修复 → 验证 → 归档 */
export const EVENT_LIFECYCLE_STEPS = [
  { key: 'detect', labelKey: 'lifecycle.detect' },
  { key: 'fix', labelKey: 'lifecycle.fix' },
  { key: 'validate', labelKey: 'lifecycle.validate' },
  { key: 'archive', labelKey: 'lifecycle.archive' },
] as const;

/** 事件闭环阶段键（取自 EVENT_LIFECYCLE_STEPS，与事件 status 经 STATUS_TO_STAGE 映射） */
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
  'runtime-exception': 'page.sentinel.type.runtimeException',
  'http-error': 'page.sentinel.type.httpError',
  'performance-degradation': 'page.sentinel.type.performanceDegradation',
  crash: 'page.sentinel.type.crash',
  'frontend-error': 'page.sentinel.type.frontendError',
  'white-screen': 'page.sentinel.type.whiteScreen',
  'security-incident': 'page.sentinel.type.securityIncident',
  'memory-leak': 'page.sentinel.type.memoryLeak',
  timeout: 'page.sentinel.type.timeout',
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

/** 事件列表数据：事件状态 + 刷新（**只取当前项目**的事件，projectId 必传） */
function useSentinelEventData(projectPath: string, onLoaded: () => void): {
  events: SentinelEventItem[];
  refreshEvents: () => void;
} {
  const [events, setEvents] = useState<SentinelEventItem[]>([]);

  const refreshEvents = useCallback(() => {
    // projectId 必须传：事件表是多项目共用的，缺省会把别的项目的待处理事件
    // 显示到当前项目名下，而评分卡按项目算分 ⇒「3 个问题却 100 分」的口径分裂
    //（2026-10-26 实测修复）。
    getSentinelEvents({ projectId: projectPath, excludeInformational: true })
      .then((data) => setEvents((data ?? []).map(toSentinelEventItem)))
      .finally(onLoaded);
  }, [projectPath, onLoaded]);

  return { events, refreshEvents };
}

/** 哨兵事件（@zh/sentinel 运行期形状）→ 页面展示模型：只映射真实存在的字段 */
function toSentinelEventItem(e: SentinelEvent): SentinelEventItem {
  return {
    id: e.id,
    title: e.title,
    // 运行期无 type 字段，module 是最贴近的语义来源（TYPE_LABELS 未命中时回退原始文本）
    type: e.module,
    severity: e.severity,
    source: e.service,
    status: e.status,
    occurrenceCount: e.occurrenceCount,
    // HTTP/IPC 序列化差异：Date 或 ISO 字符串均需规整为 string
    lastSeen: e.lastSeen instanceof Date ? e.lastSeen.toISOString() : String(e.lastSeen),
  };
}

/** 监控启停：监控状态 + 开启/停止动作（挂载即自动启动，IPC 侧幂等） */
function useSentinelMonitoring(
  projectPath: string,
  refreshEvents: () => void,
): {
  monitoring: boolean;
  stopping: boolean;
  startMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
} {
  const [monitoring, setMonitoring] = useState(false);
  /** 已发出停止、等主进程确认（按钮显示「停止中」并禁用，防连点） */
  const [stopping, setStopping] = useState(false);

  const startMonitoring = useCallback(async () => {
    const result = await startSentinelMonitoring(projectPath);
    if (result.disabled) {
      setMonitoring(false);
      return;
    }
    if (result.ok) {
      setMonitoring(true);
      await refreshEvents();
    }
  }, [projectPath, refreshEvents]);

  /**
   * 停止监控（用户诉求：开了就停不了）。
   *
   * 主进程说 `stopped=false`（该项目本就不在监控中）时，同样按"没在监控"处理 ——
   * 页面状态可能比主进程新（主进程重启后内存表清空），以主进程为准才不会
   * 显示"已停止"而后台还在跑。
   */
  const stopMonitoring = useCallback(async () => {
    setStopping(true);
    try {
      await stopSentinelMonitoring(projectPath);
      setMonitoring(false);
    } finally {
      setStopping(false);
    }
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    getSentinelState()
      .then((state) => {
        if (!cancelled && state.enabled) {
          void startMonitoring();
        }
      })
      .catch(() => {
        if (!cancelled) void startMonitoring();
      });
    return () => {
      cancelled = true;
    };
  }, [startMonitoring]);

  return { monitoring, stopping, startMonitoring, stopMonitoring };
}

/** 事件列表状态：加载 + 监控启停 */
function useSentinelEvents(projectPath: string): {
  events: SentinelEventItem[];
  loading: boolean;
  monitoring: boolean;
  stopping: boolean;
  refreshEvents: () => void;
  startMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
} {
  const [loading, setLoading] = useState(true);
  const markLoaded = useCallback(() => setLoading(false), [setLoading]);
  const { events, refreshEvents } = useSentinelEventData(projectPath, markLoaded);
  const { monitoring, stopping, startMonitoring, stopMonitoring } = useSentinelMonitoring(
    projectPath,
    refreshEvents,
  );
  const startWithLoading = useLoadingAction(startMonitoring, setLoading);

  useEffect(() => {
    refreshEvents();
  }, [refreshEvents]);

  useSentinelPolling(monitoring, refreshEvents);

  return {
    events,
    loading,
    monitoring,
    stopping,
    refreshEvents,
    startMonitoring: startWithLoading,
    stopMonitoring,
  };
}

/**
 * 哨兵主按钮的忙态判定 —— 主页与详情页**唯一同源口径**。
 *
 * 背景（2026-10-26 用户反馈）：「为什么哨兵监控里面的主页按钮上面没有停止按钮
 * 功能，详情页按钮上面才有暂停功能？」
 *
 * 根因不是停止能力缺失（`sentinel:stopMonitoring` 通道 / preload / engineApi
 * 三层都在），而是**两个视图各算各的忙态**：
 *   - 详情页 `loading={monitoring || loading}` ⇒ 监控中进入忙态 ⇒ hover 出「停止」；
 *   - 主页   `loading={loading}`                ⇒ **漏了 monitoring** ⇒ 监控中不忙
 *     ⇒ 不出「停止」；点击落到 onAction（切详情 + 幂等重启动）⇒ 表现为"点了
 *     没反应"，而且永远停不掉。
 *
 * 哨兵是**常驻守护**：monitoring 才是"在跑"的真实状态，loading 只是拉事件列表
 * 那一瞬。所以两边都必须把 monitoring 算进忙态。本函数把这套判定收成一处，
 * 页面只调一次，两个视图都从它取值 —— 口径不再分叉，也就不用再各修各的。
 */
export interface SentinelActionState {
  /** 按钮是否处于忙态（忙态才可能 hover 出「停止」） */
  busy: boolean;
  /** 运行态文案归属：监控中用 sentinelMonitor（"监控中…"），其余用 sentinel（"刷新中…"） */
  domain: 'sentinelMonitor' | 'sentinel';
  /** 忙态是否可停（只有监控中可停；拉事件列表时没有可取消的执行器） */
  cancellable: boolean;
  /** 已发出取消、等主进程确认（显示「停止中…」并禁用，防连点） */
  stopping: boolean;
}

export function deriveSentinelActionState(input: {
  monitoring: boolean;
  loading: boolean;
  stopping: boolean;
}): SentinelActionState {
  if (input.monitoring) {
    return {
      busy: true,
      domain: 'sentinelMonitor',
      cancellable: true,
      stopping: input.stopping,
    };
  }
  // 未监控：只有"正在拉事件列表"这一瞬是忙态，而刷新没有可取消的执行器 ⇒ 不可停
  return { busy: input.loading, domain: 'sentinel', cancellable: false, stopping: false };
}

/** 事件严重度 / 活跃状态统计 */
function countSentinelStats(events: SentinelEventItem[]): {
  criticalCount: number;
  highCount: number;
  activeCount: number;
} {
  const criticalCount = events.filter((e) => e.severity === 'critical').length;
  const highCount = events.filter((e) => e.severity === 'high').length;
  const activeCount = events.filter((e) =>
    ['detected', 'assigned', 'fixing'].includes(e.status),
  ).length;
  return { criticalCount, highCount, activeCount };
}

/** 按最后出现时间倒序排序 */
function sortSentinelEvents(events: SentinelEventItem[]): SentinelEventItem[] {
  return events.toSorted(
    (a: Readonly<SentinelEventItem>, b: Readonly<SentinelEventItem>) =>
      new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );
}

/** 误报反馈数量（按来源过滤，用于 KPI 卡展示） */
export function useSentinelPage(projectPath: string) {
  const { events, loading, monitoring, stopping, refreshEvents, startMonitoring, stopMonitoring } =
    useSentinelEvents(projectPath);
  const falsePositiveCount = useFalsePositiveCount(projectPath, 'sentinel');

  return {
    events,
    loading,
    monitoring,
    stopping,
    ...countSentinelStats(events),
    falsePositiveCount,
    sorted: sortSentinelEvents(events),
    refreshEvents,
    startMonitoring,
    stopMonitoring,
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
    domain: 'sentinel',
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
