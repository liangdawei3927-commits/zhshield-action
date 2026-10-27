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
import { toProfileSummary, waitForFlag, withOfflineTimeout } from './ProjectOnboardingPage-utils';

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
      // P1-3：云端不可达时 syncRules/resolveRules 曾无限挂起（实测 45s+ 卡死第二步）。
      // 每个网络调用都包 15s 硬超时，到点按离线降级继续——本地 SOP 规则照常可用，
      // 向导主流程绝不因云端阻塞。同步结果 ok:false 时 UI 会如实标注离线。
      const synced = await withOfflineTimeout(
        window.electronAPI?.sync?.syncRules(),
        () => null,
      );
      // synced 为 null/undefined = 超时或 API 缺失 → 离线降级：跳过 resolveRules（它也要访问云端）
      const outcome =
        synced != null
          ? await withOfflineTimeout(window.electronAPI?.sync?.resolveRules(), () => null)
          : null;
      onRuleSyncResult({
        // 超时/失败 → ok:false，OnboardingRuleSyncSummary 会显示既有离线降级文案
        ok: outcome?.ok ?? false,
        total: outcome?.total ?? 0,
        changedCount: outcome?.changed?.length ?? 0,
      });
      // 工具就绪探测（云端清单优先；失败/离线时主进程降级本地默认）
      try {
        const status = await withOfflineTimeout(
          window.electronAPI?.tools?.status(projectPath),
          () => null,
        );
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
