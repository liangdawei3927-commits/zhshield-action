import { useT } from '../i18n';
import { ResultCard } from '../components/ui/ResultCard';

export { EventsPanel } from './sentinel-event-parts';
export { eventToAiFixIssue, eventToFalsePositiveItem } from './sentinel-logic';

export function SentinelTimeline({
  events,
}: {
  events: Array<{ id: string; title: string; severity: string; lastSeen: string; status: string }>;
}) {
  const t = useT();
  if (events.length === 0) return null;
  return (
    <ResultCard variant="section" className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-zh-ink">
          {t('page.sentinel.timeline.title', { defaultValue: '事件时间线' })}
        </h2>
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
              <div
                className="absolute -left-4 top-1 w-3 h-3 rounded-full border-2 border-white"
                style={{ background: sev.color }}
              />
              <div className="rounded-lg border border-zh-line p-3 bg-zh-panel">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zh-ink-2">{event.title}</span>
                  <span className="ml-auto text-[11px] text-zh-muted">
                    {new Date(event.lastSeen).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}
