/** 带 status 的 HTTP 错误：区分可重试（429/5xx）与不可重试（其余 4xx）响应 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 瞬态错误判定：
 * - 网络层故障（fetch 抛 TypeError）→ 可重试
 * - HTTP 429 / 5xx → 可重试
 * - 其余 4xx、AbortError、未知错误 → 不可重试（立即失败）
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error && err.name === 'AbortError') return false;
  return err instanceof TypeError;
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 3 */
  attempts?: number;
  /** 首次退避基数（毫秒），默认 300 */
  baseDelayMs?: number;
  /** 单次退避上限（毫秒），默认 4000 */
  maxDelayMs?: number;
  /** 中止信号：仅控制重试循环；触发后放弃剩余重试并抛出最后一次错误 */
  signal?: AbortSignal;
}

type SleepResult = 'done' | 'aborted';

function sleep(ms: number, signal?: AbortSignal): Promise<SleepResult> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish('done'), ms);
    const onAbort = () => finish('aborted');
    function finish(result: SleepResult): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 有界指数退避重试（含抖动），只对瞬态失败重试。
 * 第 n 次退避基数 = min(maxDelayMs, baseDelayMs × 2^(n-1))，
 * 实际延迟在基数的 [50%, 100%] 区间内随机，避免重试风暴同步。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const signal = options.signal;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || signal?.aborted || !isTransientError(err)) {
        throw err;
      }
    }
    const nominal = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = nominal * (0.5 + 0.5 * Math.random());
    if ((await sleep(delay, signal)) === 'aborted') {
      throw lastError;
    }
  }
  throw lastError;
}
