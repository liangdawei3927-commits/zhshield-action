// 项目引导页（重构后：仅保留主组件与必要导出，其他逻辑已拆分至同目录子模块）
import { useState } from 'react';
import { useT } from '../../i18n';
import { buildSteps } from './ProjectOnboardingPage-steps';
import { useStepAdvance, useToolsStatusState } from './ProjectOnboardingPage-hooks';
import { OnboardingContent } from './ProjectOnboardingPage-ui';
import type { ProjectOnboardingPageProps } from './ProjectOnboardingPage-types';

export type {
  ProjectOnboardingPageProps,
  OnboardingProfileSummary,
  RuleSyncSummary,
  ToolsStatusSummary,
} from './ProjectOnboardingPage-types';

export { LOW_CONFIDENCE_THRESHOLD } from './ProjectOnboardingPage-types';

export function ProjectOnboardingPage({
  projectName,
  projectPath,
  onComplete,
  onClose,
  intelligentEnabled = true,
}: ProjectOnboardingPageProps) {
  const t = useT();
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [presetConfirmed, setPresetConfirmed] = useState(false);
  const [profileSummary, setProfileSummary] = useState<import('./ProjectOnboardingPage-types').OnboardingProfileSummary | null>(null);
  const [profileConfirmed, setProfileConfirmed] = useState(false);
  const [ruleSyncSummary, setRuleSyncSummary] = useState<import('./ProjectOnboardingPage-types').RuleSyncSummary | null>(null);
  const { toolsStatus, setToolsStatus, refreshTools } = useToolsStatusState(projectPath);

  const steps = buildSteps({
    projectPath,
    presetConfirmed,
    selectedPreset,
    profileDetected: profileSummary !== null,
    profileConfirmed,
    onProfileDetected: setProfileSummary,
    onRuleSyncResult: setRuleSyncSummary,
    onToolsStatus: setToolsStatus,
  });
  const { currentStepIndex, completedSteps } = useStepAdvance({
    steps,
    presetConfirmed,
    profileDetected: profileSummary !== null,
    profileConfirmed,
    onComplete,
  });

  return (
    <OnboardingContent
      t={t}
      projectName={projectName}
      steps={steps}
      currentStepIndex={currentStepIndex}
      completedSteps={completedSteps}
      progress={Math.min((currentStepIndex / steps.length) * 100, 100)}
      selectedPreset={selectedPreset}
      onSelectPreset={setSelectedPreset}
      onConfirmPreset={() => setPresetConfirmed(true)}
      showPreset={
        currentStepIndex < steps.length &&
        steps[currentStepIndex].id === 'preset' &&
        !presetConfirmed
      }
      showConfirm={
        currentStepIndex < steps.length &&
        steps[currentStepIndex].id === 'confirm' &&
        profileSummary !== null &&
        !profileConfirmed
      }
      profileSummary={profileSummary}
      onConfirmProfile={() => setProfileConfirmed(true)}
      ruleSyncSummary={ruleSyncSummary}
      toolsStatus={toolsStatus}
      onRefreshTools={refreshTools}
      onClose={onClose}
      intelligentEnabled={intelligentEnabled}
    />
  );
}
