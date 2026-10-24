import { useCallback, useEffect, useState } from 'react';
import { SectionTitle } from './sidebar-common';
import { BounceCard } from '../ui/Bounce';
import { useT } from '../../i18n';
import type { SopSyncHealth } from '../../types/electron';

/** 健康度轮询间隔：同步由主进程 6h 定时触发，UI 只需低频跟进其状态变化 */
const HEALTH_POLL_INTERVAL_MS = 60_000;

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * 把时间戳格式化为「今天 / 昨天 / N 天前」。
 *
 * 按本地日历日归一化再相减：直接按毫秒差取整会把「前天 23:00」算成 1 天前，
 * 而用户认知里那是 2 天前。
 */
export function formatRelativeDay(iso: string | null, t: Translate): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return t('layout.brainToday');
  if (days === 1) return t('layout.brainYesterday');
  return t('layout.brainDaysAgo', { days });
}

/** 失败原因的人话解释；最近一次成功（none）时不显示任何原因行 */
export function describeFailure(kind: SopSyncHealth['failureKind'], t: Translate): string | null {
  switch (kind) {
    case 'network':
      return t('layout.brainErrorNetwork');
    case 'compatibility':
      return t('layout.brainErrorCompat');
    case 'signature':
      return t('layout.brainErrorSignature');
    case 'unknown':
      return t('layout.brainErrorUnknown');
    case 'none':
      return null;
  }
}

export interface EngineCardProps {
  intelligentEnabled: boolean;
  setIntelligentEnabled: (enabled: boolean) => void;
  intelligentLoading: boolean;
}

/** 智能引擎卡：标题「智能引擎」+ 副标题 + 总开关，一键联动门禁+哨兵 */
export function EngineStatusSection({
  intelligentEnabled,
  setIntelligentEnabled,
  intelligentLoading,
}: EngineCardProps) {
  const t = useT();
  return (
    <section>
      <SectionTitle
        label={t('layout.engineStatus')}
        icon={
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="16" height="16" x="4" y="4" rx="2" />
            <rect width="6" height="6" x="9" y="9" rx="1" />
            <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-2">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-zh-ink truncate">
              {intelligentEnabled ? t('layout.engineIdle') : t('layout.engineOff')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIntelligentEnabled(!intelligentEnabled)}
            disabled={intelligentLoading}
            aria-label={t('layout.engineStatus')}
            className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors border cursor-pointer ${
              intelligentLoading ? 'opacity-50 cursor-wait' : ''
            } ${intelligentEnabled ? 'bg-success-700 border-success-700' : 'bg-zh-ink-2/20 border-zh-ink-2/30'}`}
          >
            <span
              className={`block w-4 h-4 rounded-full shadow-sm transition-transform ${
                intelligentEnabled ? 'bg-white translate-x-4' : 'bg-zh-ink-2/60 translate-x-0'
              }`}
            />
          </button>
        </div>
        <p className="text-xs leading-relaxed text-zh-muted">
          {intelligentEnabled ? t('layout.engineSubtitle') : t('layout.enginePromptOff')}
        </p>
      </BounceCard>
    </section>
  );
}

/**
 * 由健康度快照推导展示形态。
 *
 * everSucceeded=false 优先级高于 level：此时 level 恒为 4（无上次成功时间），
 * 但语义是「从未接入」而不是「过期 28 天」，文案必须不同。
 */
export function resolveStatus(
  health: SopSyncHealth | null,
  t: Translate,
): { dot: string; text: string } {
  if (!health) return { dot: 'bg-zh-ink-2/40', text: t('layout.brainChecking') };
  if (!health.everSucceeded) {
    return { dot: 'bg-warning-500', text: t('layout.brainNotConnected') };
  }
  if (health.level === 0) return { dot: 'bg-success-700', text: t('layout.brainHealthy') };
  if (health.level <= 3) return { dot: 'bg-warning-500', text: t('layout.brainUpdating') };
  const days =
    health.daysSinceSuccess === null ? null : Math.floor(health.daysSinceSuccess);
  return {
    dot: 'bg-danger-600',
    text: days !== null && days > 0 ? t('layout.brainStaleDays', { days }) : t('layout.brainStale'),
  };
}

/**
 * 智汇大脑卡：云协同状态展示（SOP 规则下发 / 经验回写），不设开关，常驻服务
 *
 * 状态必须区分「从未接入云端」与「接入过但已过期」：两者用户处置完全不同，
 * 前者是配置问题（云端地址未部署/未连通），后者是链路中断。
 * 过去二者都显示为「同步已过期」，用户无从判断该检查什么。
 */
export function WisdomBrainCard() {
  const t = useT();
  const [health, setHealth] = useState<SopSyncHealth | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electronAPI?.sop?.getSyncHealth();
      setHealth(next ?? null);
    } catch {
      // 主进程尚未就绪时保留上一次状态，不因一次查询失败就把卡片闪成异常
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.electronAPI?.sop?.getSyncHealth();
        if (!cancelled) setHealth(next ?? null);
      } catch {
        /* 同上：单次查询失败不改变既有展示 */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), HEALTH_POLL_INTERVAL_MS);
    // 窗口重新可见时立即刷新：轮询间隔内用户可能刚从休眠恢复，状态已变
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const retry = useCallback(async (): Promise<void> => {
    setRetrying(true);
    try {
      await window.electronAPI?.sop?.syncNow();
    } catch {
      /* 失败原因由健康度快照承载，此处不重复提示 */
    } finally {
      setRetrying(false);
    }
    await load();
  }, [load]);

  const status = resolveStatus(health, t);
  const failureText = health ? describeFailure(health.failureKind, t) : null;
  const lastSuccessText = health ? formatRelativeDay(health.lastSuccessAt, t) : null;

  /** 仅在「确实曾经同步成功过」时才展示上次成功时间，避免从未接入却显示「上次同步：—」 */
  const showLastSync = health?.everSucceeded === true && lastSuccessText !== null;

  return (
    <section>
      <SectionTitle
        label={t('layout.brainTitle')}
        icon={
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
          </svg>
        }
      />
      <BounceCard className="rounded-xl bg-zh-panel/60 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          <span className="text-xs font-medium text-zh-ink">{status.text}</span>
        </div>

        {showLastSync && (
          <p className="text-xs leading-relaxed text-zh-muted">
            {t('layout.brainLastSync', { time: lastSuccessText })}
          </p>
        )}

        {failureText !== null && (
          <p className="text-xs leading-relaxed text-danger-600">{failureText}</p>
        )}

        <p className="text-xs leading-relaxed text-zh-muted">{t('layout.brainSubtitle')}</p>

        {health !== null && health.level > 0 && (
          <button
            type="button"
            onClick={() => void retry()}
            disabled={retrying}
            className={`self-start text-xs px-2 py-1 rounded-md border border-zh-ink-2/30 text-zh-ink transition-colors cursor-pointer ${
              retrying ? 'opacity-50 cursor-wait' : 'hover:bg-zh-ink-2/10'
            }`}
          >
            {retrying ? t('layout.brainRetrying') : t('layout.brainRetry')}
          </button>
        )}
      </BounceCard>
    </section>
  );
}
