// 项目引导页 UI 组件（重构后：按功能拆分导出）
import type { OnboardingProfileSummary, RuleSyncSummary, ToolsStatusSummary } from './ProjectOnboardingPage-types';
import { OnboardingLogo } from './ProjectOnboardingPage-ui-core';
import {
  OnboardingCenter,
  OnboardingCloseButton,
  OnboardingEngineStatus,
} from './ProjectOnboardingPage-ui-shell';

export {
  OnboardingLogo,
  OnboardingShield,
  OnboardingProgressBar,
} from './ProjectOnboardingPage-ui-core';
export { OnboardingStepList } from './ProjectOnboardingPage-ui-steps';
export {
  OnboardingPanelAction,
  OnboardingPresetSelector,
  ProfileConfirmRow,
  OnboardingProfileConfirm,
  OnboardingRuleSyncSummary,
  toolStatusLabel,
  OnboardingToolsInstall,
  OnboardingToolsPanel,
} from './ProjectOnboardingPage-ui-panels';
export {
  OnboardingSteps,
  OnboardingCenter,
  OnboardingCloseButton,
  OnboardingEngineStatus,
} from './ProjectOnboardingPage-ui-shell';

export function OnboardingContent({
  t,
  projectName,
  steps,
  currentStepIndex,
  completedSteps,
  progress,
  selectedPreset,
  onSelectPreset,
  onConfirmPreset,
  showPreset,
  showConfirm,
  profileSummary,
  onConfirmProfile,
  ruleSyncSummary,
  toolsStatus,
  onRefreshTools,
  onClose,
  intelligentEnabled = true,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  projectName: string;
  steps: import('./ProjectOnboardingPage-types').Step[];
  currentStepIndex: number;
  completedSteps: Set<number>;
  progress: number;
  selectedPreset: string | null;
  onSelectPreset: (id: string) => void;
  onConfirmPreset: () => void;
  showPreset: boolean;
  showConfirm: boolean;
  profileSummary: OnboardingProfileSummary | null;
  onConfirmProfile: () => void;
  ruleSyncSummary: RuleSyncSummary | null;
  toolsStatus: ToolsStatusSummary | null;
  onRefreshTools: () => Promise<void>;
  onClose?: () => void;
  intelligentEnabled?: boolean;
}) {
  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, rgb(var(--zh-brand-900)) 0%, rgb(var(--zh-brand-dark)) 20%, rgb(var(--zh-brand)) 50%, rgb(var(--zh-brand-700)) 80%, rgb(var(--zh-brand-600)) 100%)',
      }}
    >
      <OnboardingLogo t={t} />

      {/* 右上角：关闭诊断页面（不等待，稍后可从侧边栏项目画像入口重新打开） */}
      {onClose && <OnboardingCloseButton onClose={onClose} />}

      {/* 智能引擎状态指示器 */}
      <OnboardingEngineStatus enabled={intelligentEnabled} />

      {/* 内部滚动舞台：内容放得下时居中，超高时可纵向滚动且顶部不被裁剪 */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-6 py-8">
          <OnboardingCenter
            projectName={projectName}
            progress={progress}
            steps={steps}
            completedSteps={completedSteps}
            currentStepIndex={currentStepIndex}
            t={t}
            showPreset={showPreset}
            selectedPreset={selectedPreset}
            onSelectPreset={onSelectPreset}
            onConfirmPreset={onConfirmPreset}
            showConfirm={showConfirm}
            profileSummary={profileSummary}
            onConfirmProfile={onConfirmProfile}
            ruleSyncSummary={ruleSyncSummary}
            toolsStatus={toolsStatus}
            onRefreshTools={onRefreshTools}
          />
          <div className="mt-6 shrink-0 text-white/40 text-xs text-center">{t('page.onboarding.hint')}</div>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
