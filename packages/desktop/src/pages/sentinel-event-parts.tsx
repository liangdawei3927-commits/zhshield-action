import {
  SEVERITY_CONFIG,
  STATUS_CONFIG,
  TYPE_LABELS,
  EVENT_LIFECYCLE_STEPS,
  statusToStage,
  eventToAiFixIssue,
  eventToFalsePositiveItem,
  type SentinelEventItem,
} from './sentinel-logic';
import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';
import { CopyAllToAiButton } from '../components/ui/CopyAllToAiButton';
import { useToast } from '../components/ui/Toast';
import { copyIssuesToAi } from '../utils/copyToAi';
import { reportFalsePositive } from '../services/engineApi';

/** 事件闭环进度条：发现 → 修复 → 验证 → 归档，当前阶段按状态着色 */
function EventLifecycle({ status }: { status: string }) {
  const t = useT();
  const stage = statusToStage(status);
  const st = STATUS_CONFIG[status] ?? {
    textKey: status,
    color: 'rgb(var(--zh-muted))',
    bg: 'rgb(var(--zh-muted) / 0.15)',
  };
  const currentIdx = EVENT_LIFECYCLE_STEPS.findIndex((s) => s.key === stage);
  return (
    <div className="mt-3 flex items-center gap-2">
      {EVENT_LIFECYCLE_STEPS.map((step, idx) => {
        const isDone = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        return (
          <div key={step.key} className="flex items-center gap-2 flex-1 last:flex-none">
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
              style={
                isDone
                  ? { background: 'rgb(var(--zh-success) / 0.15)', color: 'rgb(var(--zh-success))' }
                  : isCurrent
                    ? { background: st.bg, color: st.color }
                    : { background: 'rgb(var(--zh-bg-primary))', color: 'rgb(var(--zh-muted))' }
              }
            >
              {isDone ? '✓' : idx + 1}
            </span>
            <span
              className="text-[11px] whitespace-nowrap"
              style={{
                color: isCurrent
                  ? st.color
                  : isDone
                    ? 'rgb(var(--zh-success))'
                    : 'rgb(var(--zh-muted))',
              }}
            >
              {t(step.labelKey)}
            </span>
            {idx < EVENT_LIFECYCLE_STEPS.length - 1 && (
              <div
                className="flex-1 h-px"
                style={{ background: isDone ? 'rgb(var(--zh-success))' : 'rgb(var(--zh-line))' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

type EventContextLocationData = NonNullable<NonNullable<SentinelEventItem['context']>['location']>;

function EventContextLocation({ location }: { location: EventContextLocationData | undefined }) {
  if (!location?.file) return null;
  return (
    <div className="mt-2 rounded-lg bg-zh-panel border border-zh-line px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-zh-muted">
        {location.module && (
          <span className="px-1.5 py-0.5 rounded bg-info-50 text-info-600 font-medium">
            {location.module}
          </span>
        )}
        <span className="font-mono">
          {location.file}:{location.line}
          {location.column != null ? `:${location.column}` : ''}
        </span>
      </div>
      {location.snippet && (
        <pre className="mt-1 font-mono text-[11px] text-zh-ink-2 whitespace-pre-wrap">
          {location.snippet}
        </pre>
      )}
    </div>
  );
}

function EventRow({ event, projectPath }: { event: SentinelEventItem; projectPath: string }) {
  const t = useT();
  const sev = SEVERITY_CONFIG[event.severity] ?? SEVERITY_CONFIG.info;
  const st = STATUS_CONFIG[event.status] ?? {
    textKey: event.status,
    color: 'rgb(var(--zh-muted))',
  };
  const { toast } = useToast();
  const handleReportFalsePositive = () => {
    void reportFalsePositive(projectPath, eventToFalsePositiveItem(event)).then(
      (result) =>
        result.ok
          ? toast(t('page.sentinel.falsePositiveSubmitted'))
          : toast(result.reason ?? t('page.sentinel.submitFailed'), 'error'),
      () => toast(t('page.sentinel.submitFailed'), 'error'),
    );
  };
  return (
    <ResultCard>
      <div className="flex items-center gap-3">
        <span
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{ background: sev.bg, color: sev.color }}
        >
          {t(sev.textKey)}
        </span>
        <span className="text-sm font-medium text-zh-ink-2">{event.title}</span>
        <span className="ml-auto flex items-center gap-2">
          <Bounce
            as="button"
            onClick={handleReportFalsePositive}
            className="px-2 py-0.5 rounded text-[11px] font-medium text-zh-ink-2 bg-zh-panel hover:bg-zh-line border-none cursor-pointer"
          >
            {t('page.sentinel.markFalsePositive')}
          </Bounce>
          <CopyToAiButton
            onClick={() => copyIssuesToAi(projectPath, toast, [eventToAiFixIssue(event)])}
          />
          <span className="flex items-center gap-1.5 text-xs" style={{ color: st.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.color }} />
            {t(st.textKey)}
          </span>
        </span>
      </div>
      <EventLifecycle status={event.status} />
      <div className="mt-2 flex items-center gap-3 text-xs text-zh-muted">
        <span>{t(TYPE_LABELS[event.type] ?? event.type)}</span>
        <span>·</span>
        <span>
          {event.source === 'backend'
            ? t('page.sentinel.source.backend')
            : event.source === 'frontend'
              ? t('page.sentinel.source.frontend')
              : event.source === 'middleware'
                ? t('page.sentinel.source.middleware')
                : t('page.sentinel.source.infrastructure')}
        </span>
        {event.location?.file && (
          <>
            <span>·</span>
            <span className="font-mono">
              {event.location.file}
              {event.location.line != null ? `:${event.location.line}` : ''}
            </span>
          </>
        )}
        <span>·</span>
        <span>{t('page.sentinel.occurrenceCount', { count: event.occurrenceCount })}</span>
      </div>
      <div className="mt-1 text-xs text-zh-muted">
        {event.diagnosis?.suggestion ??
          (event.context?.request
            ? `${event.context.request.method} ${event.context.request.path}`
            : '')}
      </div>
      <EventContextLocation location={event.context?.location} />
    </ResultCard>
  );
}

export function EventsPanel({
  events,
  projectPath,
}: {
  events: SentinelEventItem[];
  projectPath: string;
}) {
  const t = useT();
  const { toast } = useToast();
  const handleCopyAll = () => copyIssuesToAi(projectPath, toast, events.map(eventToAiFixIssue));
  return (
    <div>
      {events.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-zh-muted">
            {t('page.sentinel.copyAllHint', { count: events.length })}
          </span>
          <CopyAllToAiButton onClick={handleCopyAll} />
        </div>
      )}
      <div className="space-y-2">
        {events.map((event) => (
          <EventRow key={event.id} event={event} projectPath={projectPath} />
        ))}
      </div>
    </div>
  );
}
