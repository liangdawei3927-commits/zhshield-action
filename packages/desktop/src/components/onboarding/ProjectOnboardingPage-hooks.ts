// 项目引导页钩子
import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ToolsStatusSummary } from './ProjectOnboardingPage-types';
import { runCurrentStep } from './ProjectOnboardingPage-steps';

export function useStepAdvance({
  steps,
  presetConfirmed,
  profileDetected,
  profileConfirmed,
  onComplete,
}: import('./ProjectOnboardingPage-types').UseStepAdvanceParams) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (currentStepIndex >= steps.length) {
      const timer = setTimeout(onComplete, 500);
      return () => clearTimeout(timer);
    }
    runCurrentStep({
      steps,
      index: currentStepIndex,
      presetConfirmed,
      profileDetected,
      profileConfirmed,
      onDone: () => {
        setCompletedSteps((prev) => new Set(prev).add(currentStepIndex));
        setCurrentStepIndex((prev) => prev + 1);
      },
    });
  }, [
    currentStepIndex,
    steps.length,
    onComplete,
    presetConfirmed,
    profileDetected,
    profileConfirmed,
  ]);

  return { currentStepIndex, completedSteps };
}

/** 工具就绪状态：探测 + 安装完成后面板刷新（探测失败保留旧状态） */
export function useToolsStatusState(projectPath: string): {
  toolsStatus: ToolsStatusSummary | null;
  setToolsStatus: Dispatch<SetStateAction<ToolsStatusSummary | null>>;
  refreshTools: () => Promise<void>;
} {
  const [toolsStatus, setToolsStatus] = useState<ToolsStatusSummary | null>(null);
  const refreshTools = async (): Promise<void> => {
    try {
      const status = await window.electronAPI?.tools?.status(projectPath);
      setToolsStatus(status ?? null);
    } catch {
      // 探测失败保留旧状态
    }
  };
  return { toolsStatus, setToolsStatus, refreshTools };
}
