import { PageShell } from '../components/business/PageShell';
import { useT } from '../i18n';
import { usePerformancePage } from './performance-logic';
import {
  AmberBolt,
  PerformanceHeader,
  PerformanceScoreCard,
  IssuesPanel,
} from './performance-parts';

interface PerformancePageProps {
  projectPath: string;
}

export function PerformancePage({ projectPath }: PerformancePageProps) {
  const t = useT();
  const { loading, progressLabel, report, copyToAi, copyAllToAi, handleScan } =
    usePerformancePage(projectPath);

  if (report) {
    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <PerformanceHeader
            report={report}
            loading={loading}
            progressLabel={progressLabel}
            onRescan={handleScan}
          />
          <PerformanceScoreCard report={report} />
          <IssuesPanel issues={report.issues} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<AmberBolt />}
      title={t('page.performance.shell.title')}
      subtitle={t('page.performance.shell.subtitle')}
      featureList={[
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          ),
          title: t('page.performance.shell.featureComplexity.title'),
          desc: t('page.performance.shell.featureComplexity.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          ),
          title: t('page.performance.shell.featureReDoS.title'),
          desc: t('page.performance.shell.featureReDoS.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 12h6l3-9 4 18 3-9h4" />
            </svg>
          ),
          title: t('page.performance.shell.featureModernApi.title'),
          desc: t('page.performance.shell.featureModernApi.desc'),
        },
        {
          icon: (
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          ),
          title: t('page.performance.shell.featureTimer.title'),
          desc: t('page.performance.shell.featureTimer.desc'),
        },
      ]}
      buttonText={t('page.performance.shell.start')}
      onAction={handleScan}
      loading={loading}
      progressLabel={progressLabel || t('page.performance.scanning')}
    />
  );
}
