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

/**
 * P1-3：引导向导网络步骤的离线超时兜底。
 *
 * 云端不可达时 syncRules 曾无限转圈（实测 45s+ 无超时无提示），卡死在向导第二步。
 * 这里给网络调用包一层硬超时：到点放弃等待并落 fallback（离线继续），
 * 主进程侧的真实同步完成与否不再阻塞向导主流程——本地 SOP 规则照常可用。
 */
export const ONBOARDING_STEP_TIMEOUT_MS = 15_000;

export async function withOfflineTimeout<T>(
  p: Promise<T> | undefined,
  onTimeout: () => T,
  timeoutMs: number = ONBOARDING_STEP_TIMEOUT_MS,
): Promise<T> {
  // API 缺失（undefined）：直接按离线降级，不等超时
  if (!p) return onTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  // 网络失败（reject）与超时同样按离线降级：向导主流程不因云端阻塞
  const raced = Promise.race([p.catch(() => onTimeout()), timeout]);
  // 先到者胜出后清掉定时器，避免向导关掉后仍挂着 15s 定时器
  return raced.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
