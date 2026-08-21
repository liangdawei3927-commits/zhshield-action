import type { GuardReportData, GuardReportRecordData } from '../types/electron';
import { useT } from '../i18n';
import { STATUS_LABELS } from './guard-logic';
import { Bounce } from '../components/ui/Bounce';
import { ResultCard } from '../components/ui/ResultCard';
import { CopyToAiButton } from '../components/ui/CopyToAiButton';

const RISK_LABELS: Record<string, { textKey: string; color: string; bg: string }> = {
  high: { textKey: 'severity.high', color: 'rgb(var(--zh-danger))', bg: 'rgb(var(--zh-danger) / 0.1)' },
  medium: { textKey: 'severity.medium', color: 'rgb(var(--zh-warning))', bg: 'rgb(var(--zh-warning) / 0.1)' },
  low: { textKey: 'severity.low', color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)' },
};

const TRIGGER_LABELS: Record<string, string> = {
  'pre-commit': 'page.guard.trigger.preCommit',
  'pre-push': 'page.guard.trigger.prePush',
  manual: 'page.guard.trigger.manual',
};

/** 落库记录 check → 页面 check 形态（复用复制到 AI 能力） */
const SEVERITY_MAP: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  error: 'high',
  warning: 'medium',
  info: 'low',
};

function recordCheckToView(check: GuardReportRecordData['checks'][number]): GuardReportData['checks'][number] {
  const status = check.status === 'passed' ? 'pass' : check.status === 'warning' ? 'warn' : 'fail';
  return {
    id: check.checkId,
    name: check.adapter,
    status,
    message: check.message,
    severity: SEVERITY_MAP[check.severity],
  };
}

function GuardHistoryCheckRow({ check, onCopyToAi, onReportFalsePositive }: { check: GuardReportRecordData['checks'][number]; onCopyToAi: (check: GuardReportData['checks'][number]) => void; onReportFalsePositive: (check: GuardReportData['checks'][number]) => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: STATUS_LABELS.fail.color }} />
      <span className="text-xs text-zh-ink-2 truncate">{check.message}</span>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <Bounce
          as="button"
          onClick={() => onReportFalsePositive(recordCheckToView(check))}
          className="px-2 py-0.5 rounded text-[11px] font-medium text-zh-ink-2 bg-zh-panel hover:bg-zh-line border-none cursor-pointer"
        >
          {t('page.guard.markFalsePositive')}
        </Bounce>
        <CopyToAiButton onClick={() => onCopyToAi(recordCheckToView(check))} />
      </div>
    </div>
  );
}

/** 历史拦截记录：风险等级 + 问题清单 + 复制到 AI + 标记误报 */
export function GuardHistory({
  records,
  onCopyToAi,
  onReportFalsePositive,
  falsePositiveCount = 0,
}: {
  records: GuardReportRecordData[];
  onCopyToAi: (check: GuardReportData['checks'][number]) => void;
  onReportFalsePositive: (check: GuardReportData['checks'][number]) => void;
  falsePositiveCount?: number;
}) {
  const t = useT();
  if (records.length === 0) return null;

  return (
    <ResultCard variant="section" className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-zh-ink">{t('page.guard.history.title')}</h2>
        <span className="text-xs text-zh-muted">{t('page.guard.history.subtitle')}</span>
        {falsePositiveCount > 0 && (
          <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium text-zh-ink-2 bg-zh-panel">
            {t('page.guard.falsePositiveCount', { count: falsePositiveCount })}
          </span>
        )}
      </div>
      <div className="space-y-3">
        {records.map((record, i) => {
          const risk = RISK_LABELS[record.riskLevel] ?? RISK_LABELS.low;
          const trigger = TRIGGER_LABELS[record.triggerSource] ?? record.triggerSource;
          const failedChecks = record.checks.filter((c) => c.status !== 'passed');
          return (
            <div key={i} className="rounded-lg border border-zh-line p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ background: risk.bg, color: risk.color }}>
                  {t(risk.textKey)}
                </span>
                <span className="text-xs text-zh-muted">{t(trigger)}</span>
                <span className="ml-auto text-xs text-zh-muted">{new Date(record.timestamp).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-zh-muted mb-2">
                <span>{t('page.guard.checkCount', { count: record.summary.total })}</span>
                <span className="text-red-500">{t('page.guard.blockedCount', { count: record.summary.blocking })}</span>
                <span className="text-amber-500">{t('page.guard.warningCount', { count: record.summary.warnings })}</span>
              </div>
              {failedChecks.length > 0 && (
                <div className="space-y-1.5">
                  {failedChecks.map((check, j) => (
                    <GuardHistoryCheckRow
                      key={j}
                      check={check}
                      onCopyToAi={onCopyToAi}
                      onReportFalsePositive={onReportFalsePositive}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ResultCard>
  );
}
