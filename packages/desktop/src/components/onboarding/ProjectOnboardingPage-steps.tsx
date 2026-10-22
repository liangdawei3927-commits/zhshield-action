// 项目引导页步骤定义
import {
  AnalyzeStepIcon,
  ConfirmStepIcon,
  ProfileStepIcon,
  SkillsStepIcon,
  PresetStepIcon,
  ReadyStepIcon,
} from './step-icons';
import type { BuildStepsParams, Step } from './ProjectOnboardingPage-types';
import { toProfileSummary, waitForFlag } from './ProjectOnboardingPage-utils';

function analyzeStep(
  projectPath: string,
  onProfileDetected: (summary: import('./ProjectOnboardingPage-types').OnboardingProfileSummary | null) => void,
): Step {
  return {
    id: 'analyze',
    labelKey: 'page.onboarding.step.analyze',
    execute: async () => {
      const result = await window.electronAPI?.engine?.runProfile(projectPath);
      onProfileDetected(toProfileSummary(result));
    },
    icon: <AnalyzeStepIcon />,
  };
}

function confirmStep(profileDetected: boolean, profileConfirmed: boolean): Step {
  return {
    id: 'confirm',
    labelKey: 'page.onboarding.step.confirm',
    execute: async () => {
      // 画像未识别（null）时无需确认，直接进入同步；已识别则等待用户确认
      if (!profileDetected) return;
      await waitForFlag(() => profileConfirmed);
    },
    icon: <ConfirmStepIcon />,
  };
}

function profileStep(
  projectPath: string,
  onRuleSyncResult: (summary: import('./ProjectOnboardingPage-types').RuleSyncSummary) => void,
  onToolsStatus: (status: import('./ProjectOnboardingPage-types').ToolsStatusSummary | null) => void,
): Step {
  return {
    id: 'profile',
    labelKey: 'page.onboarding.step.profile',
    execute: async () => {
      await window.electronAPI?.sync?.syncRules();
      const outcome = await window.electronAPI?.sync?.resolveRules();
      onRuleSyncResult({
        ok: outcome?.ok ?? false,
        total: outcome?.total ?? 0,
        changedCount: outcome?.changed?.length ?? 0,
      });
      // 工具就绪探测（云端清单优先；失败/离线时主进程降级本地默认）
      try {
        const status = await window.electronAPI?.tools?.status(projectPath);
        onToolsStatus(status ?? null);
      } catch {
        onToolsStatus(null);
      }
    },
    icon: <ProfileStepIcon />,
  };
}

function skillsStep(): Step {
  return {
    id: 'skills',
    labelKey: 'page.onboarding.step.skills',
    execute: async () => {
      await window.electronAPI?.sop?.getStats();
    },
    icon: <SkillsStepIcon />,
  };
}

function presetStep(presetConfirmed: boolean): Step {
  return {
    id: 'preset',
    labelKey: 'page.onboarding.step.preset',
    execute: async () => {
      if (!presetConfirmed) {
        await waitForFlag(() => presetConfirmed);
      }
    },
    icon: <PresetStepIcon />,
  };
}

function readyStep(projectPath: string, selectedPreset: string | null): Step {
  return {
    id: 'ready',
    labelKey: 'page.onboarding.step.ready',
    execute: async () => {
      await window.electronAPI?.engine?.runPipeline(projectPath, {
        sop: true,
        presetName: selectedPreset || undefined,
      });
    },
    icon: <ReadyStepIcon />,
  };
}

export function buildSteps({
  projectPath,
  presetConfirmed,
  selectedPreset,
  profileDetected,
  profileConfirmed,
  onProfileDetected,
  onRuleSyncResult,
  onToolsStatus,
}: BuildStepsParams): Step[] {
  return [
    analyzeStep(projectPath, onProfileDetected),
    confirmStep(profileDetected, profileConfirmed),
    profileStep(projectPath, onRuleSyncResult, onToolsStatus),
    skillsStep(),
    presetStep(presetConfirmed),
    readyStep(projectPath, selectedPreset),
  ];
}

export function runStep(step: Step, onDone: () => void): void {
  step.execute().then(onDone).catch(onDone);
}

export function runCurrentStep({
  steps,
  index,
  presetConfirmed,
  profileDetected,
  profileConfirmed,
  onDone,
}: import('./ProjectOnboardingPage-types').RunCurrentStepParams): void {
  const step = steps[index];
  if (step.id === 'preset' && !presetConfirmed) {
    return;
  }
  if (step.id === 'confirm' && profileDetected && !profileConfirmed) {
    return;
  }
  runStep(step, onDone);
}
