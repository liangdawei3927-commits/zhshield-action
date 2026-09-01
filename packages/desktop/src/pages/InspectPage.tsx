import { useT } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { useInspectPage } from './inspect-logic';
import { MagnifyingGlass, InspectHeader, ProgressBar, CheckList } from './inspect-parts';

interface InspectPageProps {
  projectPath: string;
}

export function InspectPage({ projectPath }: InspectPageProps) {
  const t = useT();
  const { report, loading, progressLabel, copyToAi, copyAllToAi, startInspect } =
    useInspectPage(projectPath);

  if (report && report.checks.length > 0) {
    const items = report.checks;
    const passCount = items.filter((i) => i.status === 'pass').length;

    return (
      <div className="h-full w-full bg-zh-bg overflow-auto">
        <div className="w-full px-8 py-10">
          <InspectHeader
            passCount={passCount}
            total={items.length}
            loading={loading}
            progressLabel={progressLabel}
            onRescan={startInspect}
          />
          <ProgressBar passCount={passCount} total={items.length} />
          <CheckList items={items} onCopyToAi={copyToAi} onCopyAll={copyAllToAi} />
        </div>
      </div>
    );
  }

  return (
    <PageShell
      illustration={<MagnifyingGlass />}
      title={t('page.inspect.empty.title')}
      subtitle={t('page.inspect.empty.subtitle')}
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
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          ),
          title: t('page.inspect.feature.build.title'),
          desc: t('page.inspect.feature.build.desc'),
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
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
          ),
          title: t('page.inspect.feature.license.title'),
          desc: t('page.inspect.feature.license.desc'),
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
              <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <polyline points="17 11 19 13 23 9" />
            </svg>
          ),
          title: t('page.inspect.feature.dependency.title'),
          desc: t('page.inspect.feature.dependency.desc'),
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
              <polyline points="3 6 5 6 21 6" />
              <path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          ),
          title: t('page.inspect.feature.garbage.title'),
          desc: t('page.inspect.feature.garbage.desc'),
        },
      ]}
      buttonText={t('page.inspect.scanNow')}
      onAction={startInspect}
      loading={loading}
      progressLabel={progressLabel || t('page.inspect.scanning')}
    />
  );
}
