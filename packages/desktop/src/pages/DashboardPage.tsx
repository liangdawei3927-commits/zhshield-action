import { useDashboardPage } from './dashboard-logic';
import type { PipelineProgress } from '../types/electron';
import { PageShell } from '../components/business/PageShell';
import { HealthRing } from './dashboard-parts';
import { GuardianFooter } from './dashboard-guardian-footer';
import { useT } from '../i18n';

interface DashboardPageProps {
  projectPath: string;
}

/** 一键全检运行中的管道进度（按钮下方附加区） */
function PipelineProgress({
  progress,
  label,
}: {
  progress: PipelineProgress;
  label: string;
}) {
  const pct = Math.round((progress.progress || 0) * 100);
  return (
    <div className="w-80 mt-5">
      <div className="flex items-center justify-between gap-3 text-xs text-zh-muted mb-1.5">
        <span className="truncate">{label} {pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-zh-line overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-700 transition-all duration-300"
          style={{ width: `${Math.min(Math.max((progress.progress || 0) * 100, 4), 100)}%` }}
        />
      </div>
    </div>
  );
}

/** AI 自动修复通知（按钮下方附加区） */
function AutoFixNotice({ notice }: { notice: string }) {
  const t = useT();
  return (
    <div className="mt-5 max-w-xl rounded-xl border border-warning-200 bg-warning-50 px-4 py-2.5 text-xs text-warning-800 leading-relaxed text-center">
      <span className="font-semibold mr-1">{t('page.dashboard.autoFix')}</span>
      {notice}
    </div>
  );
}

export function DashboardPage({ projectPath }: DashboardPageProps) {
  const t = useT();
  const {
    overview,
    running,
    progressLabel,
    pipelineProgress,
    autoFixNotice,
    handleOneClickCheck,
  } = useDashboardPage(projectPath);

  const extra = (
    <>
      {running && pipelineProgress ? (
        <PipelineProgress progress={pipelineProgress} label={progressLabel} />
      ) : null}
      {autoFixNotice && !running ? <AutoFixNotice notice={autoFixNotice} /> : null}
    </>
  );

  return (
    <PageShell
      illustration={<HealthRing score={overview ? overview.overall : null} size={190} />}
      title={t('page.dashboard.overview.title')}
      subtitle={t('page.dashboard.overview.subtitle')}
      buttonText={t('page.dashboard.runCheck.title')}
      onAction={() => void handleOneClickCheck()}
      loading={running}
      progressLabel={progressLabel || t('page.dashboard.running')}
      extra={extra}
      footer={<GuardianFooter />}
    />
  );
}