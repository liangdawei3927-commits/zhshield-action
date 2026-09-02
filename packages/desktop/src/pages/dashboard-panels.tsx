import type { PipelineProgress } from '../types/electron';
import { CHECK_SCOPE } from './dashboard-logic';
import { BounceCard } from '../components/ui/Bounce';
import { PrimaryButton } from '../components/ui/PrimaryButton';
import { useT } from '../i18n';

export function ScopeBlock({ titleKey, items }: { titleKey: string; items: readonly string[] }) {
  const t = useT();
  return (
    <div>
      <div className="text-xs font-medium text-zh-muted mb-1.5">{t(titleKey)}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="px-2.5 py-1 rounded-full text-[11px] bg-success-50 text-success-800"
          >
            {t(item)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 一键体检范围说明卡片 */
export function CheckScopePanel() {
  return (
    <BounceCard className="w-full max-w-lg rounded-2xl bg-zh-panel/80 p-5 mb-8">
      <div className="space-y-3">
        {CHECK_SCOPE.map((block) => (
          <ScopeBlock key={block.key} titleKey={block.titleKey} items={block.items} />
        ))}
      </div>
    </BounceCard>
  );
}

/** 一键体检按钮（含运行中 loading 态） */
export function CheckRunButton({
  running,
  progressLabel,
  onCheck,
}: {
  running: boolean;
  progressLabel: string;
  onCheck: () => void;
}) {
  const t = useT();
  return (
    <PrimaryButton
      onClick={onCheck}
      loading={running}
      loadingLabel={progressLabel || t('page.dashboard.running')}
    >
      {t('page.dashboard.check')}
    </PrimaryButton>
  );
}

/** 运行中进度与自动修复提示 */
export function RunStatus({
  running,
  pipelineProgress,
  autoFixNotice,
}: {
  running: boolean;
  pipelineProgress: PipelineProgress | null;
  autoFixNotice: string | null;
}) {
  const t = useT();
  return (
    <>
      {running && pipelineProgress ? (
        <p className="text-xs text-zh-muted mt-3">
          {t('page.dashboard.progress', {
            progress: Math.round((pipelineProgress.progress || 0) * 100),
          })}
          {pipelineProgress.stage === 'guard' ? t('page.dashboard.stageGuard') : ''}
          {pipelineProgress.stage === 'inspect' ? t('page.dashboard.stageInspect') : ''}
        </p>
      ) : null}

      {autoFixNotice && !running ? (
        <div className="mt-4 max-w-lg rounded-xl border border-warning-200 bg-warning-50 px-4 py-3 text-xs text-warning-800 leading-relaxed">
          <span className="font-semibold mr-1">{t('page.dashboard.autoFix')}</span>
          {autoFixNotice}
        </div>
      ) : null}
    </>
  );
}
