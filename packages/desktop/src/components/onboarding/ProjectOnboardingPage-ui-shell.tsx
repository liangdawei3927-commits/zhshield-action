// 项目引导页外壳 UI 组件
import { EngineStatusIndicator } from '../ui/EngineStatusIndicator';
import type { OnboardingStageProps } from './ProjectOnboardingPage-types';
import { OnboardingLogo, OnboardingShield, OnboardingProgressBar } from './ProjectOnboardingPage-ui-core';
import { OnboardingStepList } from './ProjectOnboardingPage-ui-steps';
import {
  OnboardingRuleSyncSummary,
  OnboardingToolsPanel,
  OnboardingProfileConfirm,
  OnboardingPresetSelector,
} from './ProjectOnboardingPage-ui-panels';
import { ONBOARDING_PRESETS } from './ProjectOnboardingPage-types';

export function OnboardingSteps(props: OnboardingStageProps) {
  const {
    steps,
    completedSteps,
    currentStepIndex,
    t,
    showPreset,
    selectedPreset,
    onSelectPreset,
    onConfirmPreset,
    showConfirm,
    profileSummary,
    onConfirmProfile,
    ruleSyncSummary,
    toolsStatus,
    onRefreshTools,
  } = props;
  return (
    <>
      <OnboardingStepList
        steps={steps}
        completedSteps={completedSteps}
        currentStepIndex={currentStepIndex}
        t={t}
      />
      {ruleSyncSummary && <OnboardingRuleSyncSummary summary={ruleSyncSummary} t={t} />}
      {toolsStatus && (
        <OnboardingToolsPanel status={toolsStatus} onRefresh={onRefreshTools} t={t} />
      )}
      {showConfirm && profileSummary && (
        <OnboardingProfileConfirm summary={profileSummary} onConfirm={onConfirmProfile} t={t} />
      )}
      {showPreset && (
        <OnboardingPresetSelector
          presets={ONBOARDING_PRESETS}
          selectedPreset={selectedPreset}
          onSelect={onSelectPreset}
          onConfirm={onConfirmPreset}
        />
      )}
    </>
  );
}

export function OnboardingCenter({
  projectName,
  progress,
  ...stageProps
}: OnboardingStageProps & { projectName: string; progress: number }) {
  return (
    <div className="relative flex flex-col items-center">
      <OnboardingShield projectName={projectName} />
      <OnboardingProgressBar progress={progress} />
      <OnboardingSteps {...stageProps} />
    </div>
  );
}

/** 右上角关闭诊断页面按钮（不等待，稍后可从侧边栏项目画像入口重新打开） */
export function OnboardingCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="关闭诊断页面"
      className="absolute top-8 right-10 flex items-center justify-center w-9 h-9 rounded-full border-none cursor-pointer text-white/80 hover:text-white transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.2)',
        WebkitAppRegion: 'no-drag',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.22)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}

/** 智能引擎状态指示器（右上角固定定位，仅展示） */
export function OnboardingEngineStatus({ enabled }: { enabled: boolean }) {
  return (
    <div
      className="absolute top-8 right-24 flex items-center gap-2 pointer-events-none"
      style={{ opacity: 0.7 }}
    >
      <EngineStatusIndicator enabled={enabled} />
    </div>
  );
}
