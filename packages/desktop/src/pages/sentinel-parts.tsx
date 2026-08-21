import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';

export { EventsPanel } from './sentinel-event-parts';
export { eventToAiFixIssue, eventToFalsePositiveItem } from './sentinel-logic';

/** 雷达扫描 SVG（线性风格） */
export function RadarScan() {
  return (
    <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
      {/* 雷达圈 */}
      <circle cx="75" cy="75" r="65" stroke="rgb(var(--zh-info) / 0.1)" strokeWidth="1" />
      <circle cx="75" cy="75" r="45" stroke="rgb(var(--zh-info) / 0.15)" strokeWidth="1" />
      <circle cx="75" cy="75" r="25" stroke="rgb(var(--zh-info) / 0.2)" strokeWidth="1" />
      {/* 十字线 */}
      <line x1="10" y1="75" x2="140" y2="75" stroke="rgb(var(--zh-info) / 0.08)" strokeWidth="1" />
      <line x1="75" y1="10" x2="75" y2="140" stroke="rgb(var(--zh-info) / 0.08)" strokeWidth="1" />
      {/* 中心点 */}
      <circle cx="75" cy="75" r="6" fill="rgb(var(--zh-info))" />
      {/* 扫描扇形 */}
      <path d="M75 75 L75 10 A65 65 0 0 1 140 75 Z" fill="rgb(var(--zh-info) / 0.1)">
        <animateTransform attributeName="transform" type="rotate" from="0 75 75" to="360 75 75" dur="4s" repeatCount="indefinite" />
      </path>
      {/* 扫描线 */}
      <line x1="75" y1="75" x2="140" y2="75" stroke="rgb(var(--zh-info))" strokeWidth="1.5" opacity="0.6">
        <animateTransform attributeName="transform" type="rotate" from="0 75 75" to="360 75 75" dur="4s" repeatCount="indefinite" />
      </line>
      {/* 扫描点 */}
      <circle cx="75" cy="75" r="65" stroke="rgb(var(--zh-info))" strokeWidth="1.5" strokeDasharray="4 8" opacity="0.4">
        <animateTransform attributeName="transform" type="rotate" from="0 75 75" to="360 75 75" dur="4s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

export function SentinelHeader({ count, activeCount, loading, onRefresh }: { count: number; activeCount: number; loading: boolean; onRefresh: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8">
      <Bounce className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" strokeWidth="1.2" />
          <circle cx="12" cy="12" r="1.5" fill="rgb(var(--zh-info))" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" strokeWidth="1.2" />
        </svg>
      </Bounce>
      <div>
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('nav.sentinel')}</h1>
        <p className="text-sm text-zh-muted">{t('page.sentinel.headerSummary', { count, activeCount })}</p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onRefresh} loading={loading} loadingLabel={t('page.sentinel.refreshing')}>
        {t('common.refresh')}
      </PrimaryButton>
    </div>
  );
}

export function SentinelStats({ total, active, high, critical, falsePositive }: { total: number; active: number; high: number; critical: number; falsePositive: number }) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-8">
      {[
        { labelKey: 'page.sentinel.stats.total', value: total, color: 'rgb(var(--zh-info))' },
        { labelKey: 'page.sentinel.stats.active', value: active, color: 'rgb(var(--zh-warning))' },
        { labelKey: 'severity.high', value: high, color: 'rgb(var(--zh-danger))' },
        { labelKey: 'severity.critical', value: critical, color: 'rgb(var(--zh-danger-dark))' },
        { labelKey: 'page.sentinel.stats.falsePositive', value: falsePositive, color: 'rgb(var(--zh-muted))' },
      ].map((stat) => (
        <ResultCard key={stat.labelKey} variant="stats" className="flex-1 text-center">
          <div className="text-xs text-zh-muted">{t(stat.labelKey)}</div>
          <div className="text-2xl font-bold mt-1" style={{ color: stat.color }}>{stat.value}</div>
        </ResultCard>
      ))}
    </div>
  );
}

export function SentinelTimeline({ events }: { events: Array<{ id: string; title: string; severity: string; lastSeen: string; status: string }> }) {
  const t = useT();
  if (events.length === 0) return null;
  return (
    <ResultCard variant="section" className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-zh-ink">{t('page.sentinel.timeline.title', { defaultValue: '事件时间线' })}</h2>
      </div>
      <div className="relative pl-6">
        <div className="absolute left-2 top-0 bottom-0 w-px bg-zh-line" />
        {events.slice(0, 10).map((event) => {
          const sevConfig: Record<string, { color: string }> = {
            critical: { color: 'rgb(var(--zh-danger-dark))' },
            high: { color: 'rgb(var(--zh-danger))' },
            medium: { color: 'rgb(var(--zh-warning))' },
            low: { color: 'rgb(var(--zh-info))' },
          };
          const sev = sevConfig[event.severity] ?? sevConfig.low;
          return (
            <div key={event.id} className="relative mb-4 last:mb-0">
              <div className="absolute -left-4 top-1 w-3 h-3 rounded-full border-2 border-white" style={{ background: sev.color }} />
              <div className="rounded-lg border border-zh-line p-3 bg-zh-panel">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zh-ink-2">{event.title}</span>
                  <span className="ml-auto text-[11px] text-zh-muted">{new Date(event.lastSeen).toLocaleString()}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}
