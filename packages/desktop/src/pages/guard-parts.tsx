import { useState, useEffect, useCallback } from 'react';
import type { GuardReportData } from '../types/electron';
import { useT } from '../i18n';
import { STATUS_LABELS, type GuardLevelInfo } from './guard-logic';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { readGuardConfig, writeGuardConfig } from '../services/engineApi';

export { GuardTable } from './guard-table-parts';
export { GuardHistory } from './guard-history-parts';

/** 盾牌 + 闪电 SVG（线性风格） */
export function ShieldLightning() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      {/* 外层光晕 */}
      <circle cx="75" cy="75" r="70" fill="rgb(var(--zh-brand) / 0.06)" />
      <circle cx="75" cy="75" r="60" fill="rgb(var(--zh-brand) / 0.04)" />
      {/* 盾牌 */}
      <path d="M75 20L30 48v28c0 23.33 17.02 45 45 50 27.98-5 45-26.67 45-50V48L75 20z" fill="rgb(var(--zh-brand) / 0.06)" stroke="rgb(var(--zh-brand))" strokeWidth="2.5" />
      {/* 闪电 */}
      <path d="M75 48L58 78h12l-4 24 20-30H74l4-24z" fill="none" stroke="rgb(var(--zh-brand))" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

const STATUS_BANNER: Record<string, { textKey: string; color: string; bg: string }> = {
  pass: { textKey: 'page.guard.banner.pass', color: 'rgb(var(--zh-success))', bg: 'rgb(var(--zh-success) / 0.1)' },
  warn: { textKey: 'page.guard.banner.warn', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)' },
  fail: { textKey: 'page.guard.banner.fail', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
};

/** 守护状态横幅：整体门禁状态 + 上次扫描/拦截时间 */
export function GuardStatusBanner({ report, status, loading, progressLabel, onRescan }: { report: GuardReportData | null; status: 'pass' | 'warn' | 'fail'; loading: boolean; progressLabel?: string; onRescan: () => void }) {
  const t = useT();
  const banner = STATUS_BANNER[status] ?? STATUS_BANNER.pass;
  const lastAt = report?.metadata.timestamp ?? null;
  return (
    <div className="flex items-center gap-4 mb-6">
      <Bounce className="shrink-0"><ShieldLightning /></Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('nav.guard')}</h1>
        <p className="text-sm text-zh-muted">
          {lastAt ? t('page.guard.lastScan', { time: new Date(lastAt).toLocaleString() }) : t('page.guard.idleSubtitle')}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="px-4 py-2 rounded-full text-sm font-semibold" style={{ background: banner.bg, color: banner.color }}>
          {t(banner.textKey)}
        </span>
        <PrimaryButton className="ml-auto" onClick={onRescan} loading={loading} loadingLabel={progressLabel || t('page.guard.scanning')}>
          {t('page.guard.scan')}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** 三级拦截关卡卡片：L1 提交 / L2 推送 / L3 CI */
export function GuardLevels({ levels }: { levels: GuardLevelInfo[] }) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-8">
      {levels.map((level) => {
        const st = STATUS_LABELS[level.status] ?? { textKey: 'page.guard.status.idle', color: 'rgb(var(--zh-muted))', bg: 'rgb(var(--zh-muted) / 0.08)' };
        return (
          <ResultCard key={level.level} variant="stats" className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded text-xs font-bold" style={{ background: st.bg, color: st.color }}>{level.level}</span>
              <span className="text-sm font-medium text-zh-ink-2">{t(level.labelKey)}</span>
            </div>
            <div className="text-2xl font-bold mt-2" style={{ color: st.color }}>
              {level.status === 'idle' ? '—' : level.blockingCount}
            </div>
            <div className="text-xs text-zh-muted mt-1">
              {level.status === 'idle' ? t('page.guard.status.idle') : t('page.guard.blockingCount', { count: level.blockingCount })}
            </div>
            {level.lastAt && (
              <div className="text-[11px] text-zh-muted mt-2">
                {t('page.guard.lastBlockAt', { time: new Date(level.lastAt).toLocaleString() })}
              </div>
            )}
          </ResultCard>
        );
      })}
    </div>
  );
}

export function GuardStats({ report }: { report: GuardReportData }) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-8">
      {[
        { labelKey: 'page.guard.stats.totalChecks', value: report.summary.totalChecks, color: 'rgb(var(--zh-info))' },
        { labelKey: 'page.guard.stats.passed', value: report.summary.passed, color: 'rgb(var(--zh-success))' },
        { labelKey: 'page.guard.stats.warnings', value: report.summary.warnings, color: 'rgb(var(--zh-warning))' },
        { labelKey: 'page.guard.stats.blocked', value: report.summary.blocked, color: 'rgb(var(--zh-danger))' },
      ].map((stat) => (
        <ResultCard key={stat.labelKey} variant="stats" className="flex-1 text-center">
          <div className="text-xs text-zh-muted">{t(stat.labelKey)}</div>
          <div className="text-2xl font-bold mt-1" style={{ color: stat.color }}>{stat.value}</div>
        </ResultCard>
      ))}
    </div>
  );
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-10 h-6 rounded-full relative cursor-pointer border-none transition-colors ${
        enabled ? 'bg-brand-500' : 'bg-zh-line'
      }`}
    >
      <div
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
          enabled ? 'right-0.5' : 'left-0.5'
        }`}
      />
    </button>
  );
}

function ConfigRow({ title, desc, enabled, onToggle }: { title: string; desc: string; enabled: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-zh-panel">
      <div>
        <div className="text-sm font-medium text-zh-ink-2">{title}</div>
        <div className="text-xs text-zh-muted">{desc}</div>
      </div>
      <Toggle enabled={enabled} onToggle={onToggle} />
    </div>
  );
}

export function GuardConfigCard() {
  const t = useT();
  const [preCommit, setPreCommit] = useState(true);
  const [prePush, setPrePush] = useState(true);
  const [blockCritical, setBlockCritical] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    readGuardConfig().then((config) => {
      if (!cancelled) {
        setPreCommit(config.preCommit);
        setPrePush(config.prePush);
        setBlockCritical(config.blockOnCritical);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const saveConfig = useCallback(
    (update: Partial<{ preCommit: boolean; prePush: boolean; blockOnCritical: boolean }>) => {
      const config = {
        preCommit: update.preCommit ?? preCommit,
        prePush: update.prePush ?? prePush,
        blockOnCritical: update.blockOnCritical ?? blockCritical,
      };
      void writeGuardConfig(config);
    },
    [preCommit, prePush, blockCritical],
  );

  if (loading) {
    return (
      <ResultCard variant="section" className="mt-8">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-bold text-zh-ink">{t('page.guard.config.title', { defaultValue: '门禁配置' })}</h2>
        </div>
        <div className="text-sm text-zh-muted">{t('page.guard.config.loading', { defaultValue: '加载中...' })}</div>
      </ResultCard>
    );
  }

  return (
    <ResultCard variant="section" className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-zh-ink">{t('page.guard.config.title', { defaultValue: '门禁配置' })}</h2>
      </div>
      <div className="space-y-4">
        <ConfigRow
          title={t('page.guard.config.preCommit', { defaultValue: '提交前检查' })}
          desc={t('page.guard.config.preCommitDesc', { defaultValue: '每次 git commit 前自动执行门禁检查' })}
          enabled={preCommit}
          onToggle={() => {
            const next = !preCommit;
            setPreCommit(next);
            saveConfig({ preCommit: next });
          }}
        />
        <ConfigRow
          title={t('page.guard.config.prePush', { defaultValue: '推送前检查' })}
          desc={t('page.guard.config.prePushDesc', { defaultValue: '每次 git push 前自动执行门禁检查' })}
          enabled={prePush}
          onToggle={() => {
            const next = !prePush;
            setPrePush(next);
            saveConfig({ prePush: next });
          }}
        />
        <ConfigRow
          title={t('page.guard.config.blockOnCritical', { defaultValue: '严重问题阻止提交' })}
          desc={t('page.guard.config.blockOnCriticalDesc', { defaultValue: '当检测到严重级别问题时阻止提交操作' })}
          enabled={blockCritical}
          onToggle={() => {
            const next = !blockCritical;
            setBlockCritical(next);
            saveConfig({ blockOnCritical: next });
          }}
        />
      </div>
    </ResultCard>
  );
}
