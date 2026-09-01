// F5-3 单测：wrapAdapter 的 accessScope 校验（warn-only，不阻断）
import { describe, it, expect } from 'vitest';
import {
  wrapAdapter,
  evaluateAccessScope,
  type HookedToolResult,
  type ScopeViolation,
} from '../tool-adapter-decorator';
import type { AccessScope, ToolAdapter, ToolCallHook, ToolResult, ToolScanOptions } from '../types';

const baseOptions: ToolScanOptions = { projectPath: '/tmp/proj', projectId: 'proj-1' };

function makeResult(): ToolResult {
  return {
    tool: 'eslint',
    status: 'available',
    issues: [],
    metadata: { version: '1.0.0', duration: 12, timestamp: new Date(0), fileCount: 3 },
  };
}

function makeAdapter(
  scanImpl: (options: ToolScanOptions) => Promise<ToolResult>,
  accessScope?: AccessScope,
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
    ...(accessScope ? { accessScope } : {}),
    isAvailable: async () => true,
    scan: async (options) => {
      scanCalls.push(options);
      return scanImpl(options);
    },
  };
  return { ...adapter, scanCalls };
}

describe('evaluateAccessScope', () => {
  it('flags files outside declared readPaths', () => {
    const violations = evaluateAccessScope(
      { readPaths: ['**/*.ts'], excludePaths: ['**/node_modules/**'] },
      { ...baseOptions, targetFiles: ['src/a.ts', 'docs/readme.md'] },
    );
    expect(violations).toEqual([{ file: 'docs/readme.md', reason: 'outside-read-paths' }]);
  });

  it('gives excludePaths priority over readPaths', () => {
    const violations = evaluateAccessScope(
      { readPaths: ['**/*.ts'], excludePaths: ['**/node_modules/**'] },
      { ...baseOptions, targetFiles: ['node_modules/pkg/a.ts'] },
    );
    expect(violations).toEqual([
      { file: 'node_modules/pkg/a.ts', reason: 'excluded-by-scope:**/node_modules/**' },
    ]);
  });

  it('treats missing readPaths as unrestricted but still honors sensitivePatterns', () => {
    const violations = evaluateAccessScope(
      { sensitivePatterns: ['**/.env*'] },
      { ...baseOptions, targetFiles: ['src/a.ts', '.env.local'] },
    );
    expect(violations).toEqual([{ file: '.env.local', reason: 'sensitive-path:**/.env*' }]);
  });
});

describe('wrapAdapter scope validation (F5)', () => {
  it('records out-of-scope targetFiles as violations and still executes the scan', async () => {
    const original = makeResult();
    const mock = makeAdapter(async () => original, {
      readPaths: ['**/*.{ts,js}'],
      excludePaths: ['**/node_modules/**'],
    });
    const seen: ScopeViolation[] = [];
    const wrapped = wrapAdapter(mock, [], {
      onScopeViolation: (violation) => seen.push(violation),
    });

    const result: HookedToolResult = await wrapped.scan({
      ...baseOptions,
      targetFiles: ['src/a.ts', 'node_modules/x.js', 'docs/readme.md'],
    });

    expect(mock.scanCalls).toHaveLength(1);
    expect(result.status).toBe('available');
    expect(result.scopeViolations).toEqual([
      { file: 'node_modules/x.js', reason: 'excluded-by-scope:**/node_modules/**' },
      { file: 'docs/readme.md', reason: 'outside-read-paths' },
    ]);
    expect(seen).toHaveLength(2);
  });

  it('produces no violations for in-scope targetFiles', async () => {
    const mock = makeAdapter(async () => makeResult(), {
      readPaths: ['**/*.{ts,js}'],
      excludePaths: ['**/node_modules/**'],
    });
    let callbackCount = 0;
    const wrapped = wrapAdapter(mock, [], {
      onScopeViolation: () => {
        callbackCount += 1;
      },
    });

    const result = await wrapped.scan({ ...baseOptions, targetFiles: ['src/a.ts'] });

    expect(result.scopeViolations).toBeUndefined();
    expect(callbackCount).toBe(0);
  });

  it('keeps unscoped adapters byte-identical: same result reference, no violation noise', async () => {
    const original = makeResult();
    const mock = makeAdapter(async () => original);
    let callbackCount = 0;
    const wrapped = wrapAdapter(mock, [], {
      onScopeViolation: () => {
        callbackCount += 1;
      },
    });

    const result = await wrapped.scan({ ...baseOptions, targetFiles: ['anything/else.md'] });

    expect(result).toBe(original);
    expect('scopeViolations' in result).toBe(false);
    expect(callbackCount).toBe(0);
    expect(mock.scanCalls).toHaveLength(1);
  });

  it('does not evaluate scope when a before hook blocks the scan', async () => {
    const mock = makeAdapter(async () => makeResult(), { readPaths: ['**/*.ts'] });
    let callbackCount = 0;
    const blocker: ToolCallHook = { before: () => null, after: (_a, r) => r };

    const wrapped = wrapAdapter(mock, [blocker], {
      onScopeViolation: () => {
        callbackCount += 1;
      },
    });
    const result = await wrapped.scan({ ...baseOptions, targetFiles: ['outside.md'] });

    expect(result.error).toBe('blocked-by-hook');
    expect(result.scopeViolations).toBeUndefined();
    expect(callbackCount).toBe(0);
    expect(mock.scanCalls).toHaveLength(0);
  });

  it('merges scopeViolations with hookModifications when both occur', async () => {
    const rewriter: ToolCallHook = {
      before: (_a, o) => o,
      after: () => makeResult(),
    };
    const mock = makeAdapter(async () => makeResult(), { readPaths: ['**/*.ts'] });
    const wrapped = wrapAdapter(mock, [rewriter], {});

    const result = await wrapped.scan({ ...baseOptions, targetFiles: ['outside.md'] });

    expect(result.scopeViolations).toEqual([{ file: 'outside.md', reason: 'outside-read-paths' }]);
    expect(result.hookModifications).toEqual(['after:rewrote']);
  });

  it('validates the post-hook options that actually reach adapter.scan', async () => {
    const mock = makeAdapter(async () => makeResult(), { readPaths: ['**/*.ts'] });
    const mutating: ToolCallHook = {
      before: (_adapter, options) => ({ ...options, targetFiles: ['src/in.ts', 'out.md'] }),
      after: (_adapter, result) => result,
    };
    const seen: string[] = [];
    const wrapped = wrapAdapter(mock, [mutating], {
      onScopeViolation: (violation) => seen.push(violation.file),
    });

    await wrapped.scan(baseOptions);

    expect(seen).toEqual(['out.md']);
  });
});
