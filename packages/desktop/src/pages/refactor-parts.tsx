import type { RefactorReportData } from '../types/electron';
import { useT } from '../i18n';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { type SmellGroup } from './refactor-logic';
import { SmellGroupPanel } from './refactor-panel';

export function RefactorHeader({ report, scanning, progressLabel, lastAutoAt, onScan }: { report: RefactorReportData; scanning: boolean; progressLabel?: string; lastAutoAt: string | null; onScan: () => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-4 mb-8 flex-wrap">
      <Bounce className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--zh-info))" strokeWidth="1.8">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
      </Bounce>
      <div className="flex-1 min-w-[200px]">
        <h1 className="text-2xl font-bold text-zh-ink mb-1">{t('page.refactor.header.title')}</h1>
        <p className="text-sm text-zh-muted">
          {t('page.refactor.header.summary', { totalSmells: report.totalSmells, files: report.files.length })}
          {lastAutoAt ? t('page.refactor.header.lastAutoCheck', { time: lastAutoAt }) : ''}
        </p>
      </div>
      <PrimaryButton className="ml-auto" onClick={onScan} loading={scanning} loadingLabel={progressLabel || t('page.refactor.scanning')}>
        {t('page.refactor.scanNow')}
      </PrimaryButton>
    </div>
  );
}

export function RefactorStats({ report }: { report: RefactorReportData }) {
  const t = useT();
  return (
    <div className="flex gap-4 mb-6">
      {[
        { labelKey: 'page.refactor.stats.smells', value: report.totalSmells, color: 'rgb(var(--zh-info))' },
        { labelKey: 'page.refactor.stats.files', value: report.files.length, color: 'rgb(var(--zh-warning))' },
        { labelKey: 'page.refactor.stats.highPriority', value: report.summary.needsImmediateAction, color: 'rgb(var(--zh-danger))' },
      ].map((item) => (
        <ResultCard key={item.labelKey} variant="stats" className="flex-1">
          <div className="text-xs text-zh-muted mb-1">{t(item.labelKey)}</div>
          <div className="text-xl font-bold" style={{ color: item.color }}>{item.value}</div>
        </ResultCard>
      ))}
    </div>
  );
}

export function RuleTabs({ groups, activeRuleId, onSelect }: { groups: SmellGroup[]; activeRuleId: string; onSelect: (ruleId: string) => void }) {
  const t = useT();
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {groups.map((group) => {
        const isActive = group.ruleId === activeRuleId;
        return (
          <Bounce
            as="button"
            key={group.ruleId}
            onClick={() => onSelect(group.ruleId)}
            className={`shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium border-none cursor-pointer transition-colors ${
              isActive ? 'bg-blue-600 text-white' : 'bg-zh-panel text-zh-ink-2 hover:bg-zh-line'
            }`}
          >
            {t(group.label)}
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                isActive ? 'bg-white/25 text-white' : 'bg-blue-50 text-blue-700'
              }`}
            >
              {group.items.length}
            </span>
          </Bounce>
        );
      })}
    </div>
  );
}

interface ReportViewProps {
  report: RefactorReportData;
  scanning: boolean;
  progressLabel?: string;
  lastAutoAt: string | null;
  error: string;
  groups: SmellGroup[];
  activeRuleId: string;
  activeGroup: SmellGroup | null;
  onScan: () => void;
  onSelectRule: (ruleId: string) => void;
  onCopyGroup: () => void;
  onCopyItem: (smell: import('./refactor-logic').Smell) => void;
}

/** 报告态：头部 + 统计 + 按类型分组的问题面板 */
export function RefactorReportView({
  report, scanning, progressLabel, lastAutoAt, error, groups, activeRuleId, activeGroup,
  onScan, onSelectRule, onCopyGroup, onCopyItem,
}: ReportViewProps) {
  const t = useT();
  return (
    <div className="h-full w-full bg-zh-bg overflow-auto">
      <div className="w-full px-8 py-10">
        <RefactorHeader
          report={report}
          scanning={scanning}
          progressLabel={progressLabel}
          lastAutoAt={lastAutoAt}
          onScan={onScan}
        />

        {error ? <p className="text-sm text-red-500 mb-4">{error}</p> : null}

        <RefactorStats report={report} />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zh-ink-2">{t('page.refactor.groupedIssues')}</h3>
            <span className="text-xs text-zh-muted">{t('page.refactor.groupsSummary', { groups: groups.length, total: report.totalSmells })}</span>
          </div>
          {groups.length === 0 ? (
            <ResultCard variant="list" className="p-8 text-center">
              <p className="text-sm text-zh-muted">{t('page.refactor.noSmells')}</p>
            </ResultCard>
          ) : (
            <>
              <RuleTabs groups={groups} activeRuleId={activeRuleId} onSelect={onSelectRule} />
              {activeGroup && (
                <SmellGroupPanel
                  key={activeGroup.ruleId}
                  group={activeGroup}
                  onCopyGroup={onCopyGroup}
                  onCopyItem={onCopyItem}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
