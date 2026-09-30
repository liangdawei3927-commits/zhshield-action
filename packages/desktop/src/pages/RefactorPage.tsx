import { useState } from 'react';
import { useT } from '../i18n';
import { ReportShell } from '../components/business/ReportShell';
import { Bounce } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { ResultCard } from '../components/ui/ResultCard';
import { useRefactorPage } from './refactor-logic';
import { RuleTabs } from './refactor-parts';
import { SmellGroupPanel } from './refactor-panel';
import { RefactorEmptyState } from './refactor-empty-state';

interface RefactorPageProps {
  projectPath: string;
}

export function RefactorPage({ projectPath }: RefactorPageProps) {
  const t = useT();
  const [showHome, setShowHome] = useState(false);
  const {
    scanning,
    progress,
    progressLabel,
    statusMessage,
    report,
    error,
    activeRuleId,
    setActiveRuleId,
    activeGroup,
    groups,
    copyToAi,
    copyGroupToAi,
    handleScan,
  } = useRefactorPage(projectPath);

  if (report && !showHome) {
    return (
      <ReportShell
        projectPath={projectPath}
        dimension="refactor"
        refreshKey={report}
        icon={
          <Bounce className="w-14 h-14 rounded-xl bg-info-50 flex items-center justify-center">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgb(var(--zh-info))"
              strokeWidth="2"
            >
              <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
            </svg>
          </Bounce>
        }
        title={t('page.refactor.header.title')}
        action={
          <PrimaryButton
            onClick={() => void handleScan()}
            loading={scanning}
            loadingLabel={progressLabel || t('page.refactor.scanning')}
          >
            {t('page.refactor.scanNow')}
          </PrimaryButton>
        }
        onBackHome={() => setShowHome(true)}
        stats={[
          {
            key: 'smells',
            label: t('page.refactor.stats.smells'),
            value: report.totalSmells,
            color: 'rgb(var(--zh-info))',
          },
          {
            key: 'files',
            label: t('page.refactor.stats.files'),
            value: report.files.length,
            color: 'rgb(var(--zh-warning))',
          },
          {
            key: 'highPriority',
            label: t('page.refactor.stats.highPriority'),
            value: report.summary.needsImmediateAction,
            color: 'rgb(var(--zh-danger))',
          },
        ]}
      >
        {error ? <p className="text-sm text-danger-500 mb-4">{error}</p> : null}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zh-ink-2">
              {t('page.refactor.groupedIssues')}
            </h3>
            <span className="text-xs text-zh-muted">
              {t('page.refactor.groupsSummary', {
                groups: groups.length,
                total: report.totalSmells,
              })}
            </span>
          </div>
          {groups.length === 0 ? (
            <ResultCard variant="list" className="p-8 text-center">
              <p className="text-sm text-zh-muted">{t('page.refactor.noSmells')}</p>
            </ResultCard>
          ) : (
            <>
              <RuleTabs groups={groups} activeRuleId={activeRuleId} onSelect={setActiveRuleId} />
              {activeGroup && (
                <SmellGroupPanel
                  key={activeGroup.ruleId}
                  group={activeGroup}
                  onCopyGroup={() => copyGroupToAi(activeGroup!)}
                  onCopyItem={(smell) => copyToAi(smell.location.filePath, smell)}
                />
              )}
            </>
          )}
        </div>
      </ReportShell>
    );
  }

  return (
    <RefactorEmptyState
      projectPath={projectPath}
      error={error}
      scanning={scanning}
      progress={Math.round(progress * 100)}
      statusMessage={statusMessage}
      onScan={() => {
        setShowHome(false);
        void handleScan();
      }}
    />
  );
}