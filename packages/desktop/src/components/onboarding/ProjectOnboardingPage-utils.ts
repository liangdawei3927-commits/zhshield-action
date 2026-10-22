// 项目引导页工具函数
import type { OnboardingProfileSummary } from './ProjectOnboardingPage-types';

/** 将 fingerprint ProjectProfile 投影为确认面板数据（无 targets 返回 null） */
export function toProfileSummary(result: unknown): OnboardingProfileSummary | null {
  const profile = (
    result as { profile?: { targets?: unknown[]; architecture?: { value?: string } } }
  )?.profile;
  const target = profile?.targets?.[0] as
    | {
        language?: { value?: string; confidence?: number };
        frameworks?: Array<{ value?: string }>;
      }
    | undefined;
  if (!target) return null;
  return {
    language: target.language?.value,
    framework: target.frameworks?.[0]?.value,
    architecture: profile?.architecture?.value,
    confidence: target.language?.confidence,
  };
}

/** 轮询等待布尔标志变为 true（100ms 间隔，命中后清除定时器再 resolve） */
export function waitForFlag(getFlag: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (getFlag()) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
