import { PageShell } from '../components/business/PageShell';
import { FeatureIcon, ClockGlyph } from '../components/ui/Icons';
import { useReportsPage, useModuleScores } from './reports-logic';
import {
  StackedDocs,
  ReportsHeader,
  LatestScoreCard,
  DimensionCards,
  ModuleScoreCards,
} from './reports-parts';
import { HistoryTable } from './reports-table';
import { ReportWindowSection } from './report-window-parts';
import { useT } from '../i18n';

interface ReportsPageProps {
  projectPath: string;
}

export function ReportsPage({ projectPath }: ReportsPageProps) {
  const { data, loading, handleNewReport } = useReportsPage(projectPath);
  const { modules } = useModuleScores(projectPath);
  const t = useT();

  if (data.length > 0) {
    const latest = data.at(-1)!;
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <ReportsHeader count={data.length} latest={latest} onNewReport={handleNewReport} />
          <LatestScoreCard latest={latest} data={data} />
          <DimensionCards dimensions={latest.dimensions} />
          <ModuleScoreCards modules={modules} />
          <ReportWindowSection data={data} />
          <HistoryTable data={data} />
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<StackedDocs />}
      title={t('page.reports.empty.title')}
      subtitle={t('page.reports.empty.subtitle', {
        count: 0,
        date: new Date().toLocaleDateString(),
      })}
      featureList={[
        {
          icon: (
            <FeatureIcon>
              <ClockGlyph />
            </FeatureIcon>
          ),
          title: t('page.reports.empty.feature.scoring.title'),
          desc: t('page.reports.empty.feature.scoring.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              <polyline points="17 6 23 6 23 12" />
            </FeatureIcon>
          ),
          title: t('page.reports.empty.feature.trend.title'),
          desc: t('page.reports.empty.feature.trend.desc'),
        },
        {
          icon: (
            <FeatureIcon>
              <line x1="6" y1="20" x2="6" y2="16" />
              <line x1="12" y1="20" x2="12" y2="10" />
              <line x1="18" y1="20" x2="18" y2="4" />
            </FeatureIcon>
          ),
          title: t('page.reports.empty.feature.module.title'),
          desc: t('page.reports.empty.feature.module.desc'),
        },
      ]}
      columns={3}
      buttonText={t('page.reports.generate')}
      onAction={handleNewReport}
      loading={loading}
    />
  );
}
