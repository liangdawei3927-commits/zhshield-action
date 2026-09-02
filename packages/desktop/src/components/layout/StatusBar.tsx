import { useEffect, useState } from 'react';
import { useT } from '../../i18n';

/** 三项实时防护状态：门禁 / 哨兵 / 规则同步（设计文档 01-桌面端.md §布局要点·底部） */
interface ProtectionStatus {
  /** 门禁 git hooks 已安装 → 自动拦截生效 */
  guardInstalled: boolean;
  /** 哨兵总开关开启 → 7×24 监控中 */
  sentinelEnabled: boolean;
  /** 云脑规则是否全部最新 */
  rulesSynced: boolean;
}

type ItemState = 'ok' | 'warn' | 'off';

const DOT: Record<ItemState, string> = {
  ok: 'bg-success-500',
  warn: 'bg-warning-500',
  off: 'bg-zh-muted',
};

function StatusBar({
  activeProjectPath,
  intelligentEnabled,
}: {
  activeProjectPath?: string;
  intelligentEnabled: boolean;
}) {
  const t = useT();
  const [status, setStatus] = useState<ProtectionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void (async () => {
        try {
          const api = window.electronAPI;
          if (!api) return;
          const [hooks, sentinel, rules] = await Promise.all([
            activeProjectPath
              ? (api.guardHooks?.getStatus(activeProjectPath) ??
                Promise.resolve({ hasGitDir: false, installed: [] as string[] }))
              : Promise.resolve({ hasGitDir: false, installed: [] as string[] }),
            api.sentinel?.getState?.() ?? Promise.resolve({ enabled: false }),
            api.sync?.getRulesStatus?.() ?? Promise.resolve([]),
          ]);
          if (cancelled) return;
          setStatus({
            guardInstalled: intelligentEnabled && hooks.installed.length > 0,
            sentinelEnabled: sentinel.enabled,
            rulesSynced: rules.length > 0 && rules.every((r) => !r.stale),
          });
        } catch {
          // 状态栏是兜底展示，查询失败保持上次状态，不打扰主流程
        }
      })();
    };
    poll();
    const timer = window.setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeProjectPath, intelligentEnabled]);

  const items: Array<{ state: ItemState; label: string }> = [
    {
      state: !status ? 'off' : status.guardInstalled ? 'ok' : 'off',
      label: !status
        ? t('layout.statusBarChecking')
        : status.guardInstalled
          ? t('layout.statusBarGuardOn')
          : t('layout.statusBarGuardOff'),
    },
    {
      state: !status ? 'off' : status.sentinelEnabled ? 'ok' : 'warn',
      label: !status
        ? t('layout.statusBarChecking')
        : status.sentinelEnabled
          ? t('layout.statusBarSentinelOn')
          : t('layout.statusBarSentinelOff'),
    },
    {
      state: !status ? 'off' : status.rulesSynced ? 'ok' : 'warn',
      label: !status
        ? t('layout.statusBarChecking')
        : status.rulesSynced
          ? t('layout.statusBarRulesSynced')
          : t('layout.statusBarRulesStale'),
    },
  ];

  return (
    <footer
      className="flex items-center gap-4 px-4 h-8 shrink-0 border-t border-zh-line bg-zh-card text-xs text-zh-ink-2"
      aria-label={t('layout.statusBarLabel')}
    >
      <span className="font-medium text-zh-ink">{t('layout.statusBarLabel')}</span>
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${items[0].state === 'ok' ? 'animate-pulse ' : ''}${DOT[items[0].state]}`} />
        {items[0].label}
      </span>
      <span aria-hidden className="text-zh-line">·</span>
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[items[1].state]}`} />
        {items[1].label}
      </span>
      <span aria-hidden className="text-zh-line">·</span>
      <span className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[items[2].state]}`} />
        {items[2].label}
      </span>
    </footer>
  );
}

export default StatusBar;
