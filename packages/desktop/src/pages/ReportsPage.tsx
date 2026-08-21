import { PageShell } from '../components/business/PageShell';
import { useReportsPage } from './reports-logic';
import { StackedDocs, ReportsHeader, LatestScoreCard, DimensionCards } from './reports-parts';
import { HistoryTable } from './reports-table';
import { useT } from '../i18n';

interface ReportsPageProps {
  projectPath: string;
}

export function ReportsPage({ projectPath }: ReportsPageProps) {
  const { data, loading, handleNewReport } = useReportsPage(projectPath);
  const t = useT();

  if (data.length > 0) {
    const latest = data.at(-1)!;
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <ReportsHeader count={data.length} latest={latest} onNewReport={handleNewReport} />
          <LatestScoreCard latest={latest} data={data} />
          <DimensionCards dimensions={latest.dimensions} />
          <HistoryTable data={data} />
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<StackedDocs />}
      title={t('page.reports.empty.title')}
      subtitle={t('page.reports.empty.subtitle', { count: 0, date: new Date().toLocaleDateString() })}
      featureList={[
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
          ),
          title: t('page.reports.empty.feature.scoring.title'),
          desc: t('page.reports.empty.feature.scoring.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
            </svg>
          ),
          title: t('page.reports.empty.feature.trend.title'),
          desc: t('page.reports.empty.feature.trend.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          ),
          title: t('page.reports.empty.feature.pdf.title'),
          desc: t('page.reports.empty.feature.pdf.desc'),
        },
        {
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
          ),
          title: t('page.reports.empty.feature.email.title'),
          desc: t('page.reports.empty.feature.email.desc'),
        },
      ]}
      buttonText={t('page.reports.generate')}
      onAction={handleNewReport}
      loading={loading}
    />
  );
}
