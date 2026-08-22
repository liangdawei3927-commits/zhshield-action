import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HttpError, isTransientError, withRetry } from '../sop/sync/retry';

function transientFailure(): Error {
  return new TypeError('fetch failed');
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('isTransientError', () => {
  it.each([
    [new TypeError('fetch failed'), true],
    [new HttpError(429), true],
    [new HttpError(500), true],
    [new HttpError(503), true],
    [new HttpError(400), false],
    [new HttpError(401), false],
    [new HttpError(404), false],
    [abortError(), false],
    [new Error('plain'), false],
  ])('%j → %j', (err, expected) => {
    expect(isTransientError(err)).toBe(expected);
  });
});

describe('HttpError', () => {
  it('携带 status 与默认消息', () => {
    const err = new HttpError(503);
    expect(err.status).toBe(503);
    expect(err.name).toBe('HttpError');
    expect(err.message).toBe('HTTP 503');
    expect(err instanceof Error).toBe(true);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('首次成功不重试，直接返回结果', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('瞬态失败两次后成功：共调用 3 次，退避按 base→2×base 指数增长', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1); // 抖动取上界 → 延迟恰为名义值
    let calls = 0;
    const fn = vi.fn(async (): Promise<string> => {
      calls += 1;
      if (calls <= 2) throw transientFailure();
      return 'done';
    });

    const pending = withRetry(fn, { baseDelayMs: 100 });

    await vi.advanceTimersByTimeAsync(0); // 第 1 次调用已失败，sleep(100) 已排程
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99); // 未到 100ms：不重试
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // 100ms 到：第 2 次失败，sleep(200) 排程
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199); // 未到累计 300ms：不重试
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1); // 200ms 到：第 3 次成功
    await expect(pending).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(randomSpy).toHaveBeenCalled();
  });

  it('抖动边界：Math.random=0 时延迟为名义值的一半', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fn = vi.fn(async (): Promise<string> => {
      throw transientFailure();
    });

    const pending = withRetry(fn, { attempts: 2, baseDelayMs: 100 });
    const assertion = expect(pending).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49); // 半延迟 50ms 未到
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('退避受 maxDelayMs 封顶', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const fn = vi.fn(async (): Promise<string> => {
      throw transientFailure();
    });

    const pending = withRetry(fn, { attempts: 3, baseDelayMs: 800, maxDelayMs: 1000 });
    const assertion = expect(pending).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(0); // 失败①，sleep(800)
    await vi.advanceTimersByTimeAsync(800); // 失败②，名义 1600 → 封顶 sleep(1000)
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 封顶的 1000ms 到 → 第 3 次（最后一次）
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('4xx 客户端错误不重试：立即抛出且只调用一次', async () => {
    const fn = vi.fn(async (): Promise<string> => {
      throw new HttpError(400);
    });
    await expect(withRetry(fn)).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('%i 瞬态失败一次后成功：重试共 2 次', async (status) => {
    const fn = vi.fn(async (): Promise<string> => {
      if (fn.mock.calls.length === 1) throw new HttpError(status);
      return 'recovered';
    });
    const pending = withRetry(fn);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('AbortError 不重试', async () => {
    const fn = vi.fn(async (): Promise<string> => {
      throw abortError();
    });
    await expect(withRetry(fn)).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('持续瞬态失败：默认 3 次后放弃并抛出最后一次错误', async () => {
    const fn = vi.fn(async (): Promise<never> => {
      throw transientFailure();
    });
    const assertion = expect(withRetry(fn)).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('自定义 attempts=5：放弃前共调用 5 次', async () => {
    const fn = vi.fn(async (): Promise<never> => {
      throw transientFailure();
    });
    const assertion = expect(withRetry(fn, { attempts: 5, baseDelayMs: 10 })).rejects.toThrow(
      'fetch failed',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('attempts=1 等价于不重试', async () => {
    const fn = vi.fn(async (): Promise<never> => {
      throw transientFailure();
    });
    await expect(withRetry(fn, { attempts: 1 })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('退避等待期间收到中止信号：停止重试并抛出最后一次错误', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn(async (): Promise<never> => {
      throw transientFailure();
    });

    const pending = withRetry(fn, { baseDelayMs: 100, signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(0); // 第 1 次已失败，正在退避
    ctrl.abort();

    await expect(pending).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('传入已中止的信号：只尝试一次', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = vi.fn(async (): Promise<never> => {
      throw transientFailure();
    });

    await expect(withRetry(fn, { signal: ctrl.signal })).rejects.toThrow('fetch failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('非错误抛出值（字符串）不重试', async () => {
    const fn = vi.fn(async (): Promise<never> => {
      throw 'boom';
    });
    await expect(withRetry(fn)).rejects.toBe('boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
