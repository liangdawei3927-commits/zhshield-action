import { describe, it, expect } from 'vitest';
import { wrapAdapter, type HookedToolResult } from '../tool-adapter-decorator';
import type { ToolAdapter, ToolCallHook, ToolResult, ToolScanOptions } from '../types';

const baseOptions: ToolScanOptions = { projectPath: '/tmp/proj', projectId: 'proj-1' };

function makeResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    tool: 'eslint',
    status: 'available',
    issues: [],
    metadata: { version: '1.0.0', duration: 12, timestamp: new Date(0), fileCount: 3 },
    ...overrides,
  };
}

function makeAdapter(
  scanImpl: (options: ToolScanOptions) => Promise<ToolResult>,
): ToolAdapter & { scanCalls: ToolScanOptions[] } {
  const scanCalls: ToolScanOptions[] = [];
  const adapter: ToolAdapter = {
    meta: {
      id: 'eslint',
      name: 'ESLint',
      category: 'guard',
      priority: 'P0',
      installMode: 'builtin',
      description: 'mock adapter',
      cliCommand: 'eslint',
      homepage: 'https://eslint.org',
      license: 'MIT',
    },
    isAvailable: async () => true,
    scan: async (options) => {
      scanCalls.push(options);
      return scanImpl(options);
    },
  };
  return { ...adapter, scanCalls };
}

const passthroughHook: ToolCallHook = {
  before: (_adapter, options) => options,
  after: (_adapter, result) => result,
};

describe('wrapAdapter', () => {
  it('should pass the scan through unchanged when no hooks are attached', async () => {
    const original = makeResult();
    const mock = makeAdapter(async () => original);
    const wrapped = wrapAdapter(mock);

    const result = await wrapped.scan(baseOptions);

    expect(result).toBe(original);
    expect(mock.scanCalls).toHaveLength(1);
    expect(wrapped.meta.id).toBe('eslint');
    await expect(wrapped.isAvailable()).resolves.toBe(true);
  });

  it('should block the scan without calling adapter.scan when a before hook returns null', async () => {
    let scanCount = 0;
    const mock = makeAdapter(async () => {
      scanCount += 1;
      return makeResult();
    });
    const blocker: ToolCallHook = { before: () => null, after: (_a, r) => r };

    const wrapped = wrapAdapter(mock, [blocker]);
    const result: HookedToolResult = await wrapped.scan(baseOptions);

    expect(scanCount).toBe(0);
    expect(mock.scanCalls).toHaveLength(0);
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('blocked-by-hook');
    expect(result.hookModifications).toEqual(['before:blocked']);
  });

  it('should let a before hook mutate the options received by adapter.scan', async () => {
    const mock = makeAdapter(async () => makeResult());
    const mutating: ToolCallHook = {
      before: (_adapter, options) => ({ ...options, targetFiles: ['src/a.ts'] }),
      after: (_adapter, result) => result,
    };

    const wrapped = wrapAdapter(mock, [mutating]);
    await wrapped.scan(baseOptions);

    expect(mock.scanCalls[0]?.targetFiles).toEqual(['src/a.ts']);
    expect(mock.scanCalls[0]?.projectId).toBe('proj-1');
  });

  it('should return the rewritten result when an after hook rewrites it', async () => {
    const original = makeResult();
    const rewritten = makeResult({ status: 'unavailable', error: 'rewritten-by-hook' });
    const mock = makeAdapter(async () => original);
    const rewriter: ToolCallHook = {
      before: (_adapter, options) => options,
      after: () => rewritten,
    };

    const wrapped = wrapAdapter(mock, [rewriter]);
    const result: HookedToolResult = await wrapped.scan(baseOptions);

    // 改写内容原样到达调用方（附 hookModifications 注记，故为浅拷贝而非同一引用）
    expect(result).toMatchObject(rewritten);
    expect(result.status).toBe('unavailable');
    expect(result.error).toBe('rewritten-by-hook');
    expect(result.hookModifications).toEqual(['after:rewrote']);
  });

  it('should not crash the caller when an after hook throws', async () => {
    const original = makeResult();
    const mock = makeAdapter(async () => original);
    const throwing: ToolCallHook = {
      before: (_adapter, options) => options,
      after: () => {
        throw new Error('hook exploded');
      },
    };

    const wrapped = wrapAdapter(mock, [throwing]);
    const result = await wrapped.scan(baseOptions);

    expect(result).toBe(original);
    expect(mock.scanCalls).toHaveLength(1);
  });

  it('should fire before and after hooks exactly once around a single scan', async () => {
    const mock = makeAdapter(async () => makeResult());
    let beforeCount = 0;
    let afterCount = 0;
    const counting: ToolCallHook = {
      before: (_adapter, options) => {
        beforeCount += 1;
        return options;
      },
      after: (_adapter, result) => {
        afterCount += 1;
        return result;
      },
    };

    const wrapped = wrapAdapter(mock, [counting]);
    await wrapped.scan(baseOptions);

    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(mock.scanCalls).toHaveLength(1);
  });

  it('should thread malformed hook output through untouched instead of crashing', async () => {
    // 对抗性用例：伪造运行时畸形入参（静态类型禁止的形状，模拟 JS 注入的钩子）。
    // 装饰器契约是忠实透传，不做参数校验（校验属 F5 scope 层）——断言不崩溃且原样到达 adapter。
    const malformed = JSON.parse(JSON.stringify({ projectId: baseOptions.projectId })) as ToolScanOptions;
    const mock = makeAdapter(async () => makeResult());
    const hostile: ToolCallHook = {
      before: () => malformed,
      after: (_adapter, result) => result,
    };

    const wrapped = wrapAdapter(mock, [hostile]);
    const result = await wrapped.scan(baseOptions);

    expect(mock.scanCalls[0]).toBe(malformed);
    expect(result.status).toBe('available');
  });

  it('should keep threading results across multiple hooks in order', async () => {
    const first = makeResult();
    const second = makeResult({ status: 'error', error: 'first-rewrite' });
    const final = makeResult({ status: 'unavailable', error: 'second-rewrite' });
    const mock = makeAdapter(async () => first);
    const chain: ToolCallHook[] = [
      passthroughHook,
      { before: (_a, o) => o, after: () => second },
      { before: (_a, o) => o, after: () => final },
    ];

    const wrapped = wrapAdapter(mock, chain);
    const result: HookedToolResult = await wrapped.scan(baseOptions);

    expect(result.error).toBe('second-rewrite');
    expect(result.status).toBe('unavailable');
    expect(result.hookModifications).toEqual(['after:rewrote', 'after:rewrote']);
  });
});
