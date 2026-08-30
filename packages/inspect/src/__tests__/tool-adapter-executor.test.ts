import { describe, it, expect, vi } from 'vitest';
import { ToolAdapterExecutor, type ToolAdapterExecutorDeps } from '../tool-adapter-executor';
import { AuditLogger, DegradationManager, NOOP_EMITTER } from '@zh/shared';
import type { ToolAdapter, ToolCategory, ToolId, ToolResult, ToolStatus } from '@zh/shared';

function makeAdapter(id: ToolId, category: ToolCategory, status: ToolStatus): ToolAdapter {
  return {
    meta: {
      id,
      name: `Mock ${id}`,
      category,
      priority: 'P0',
      installMode: 'builtin',
      description: `mock ${id}`,
      cliCommand: id,
      homepage: '',
      license: 'MIT',
    },
    isAvailable: vi.fn().mockResolvedValue(true),
    scan: vi.fn().mockResolvedValue({
      tool: id,
      status,
      issues: [],
      metadata: { version: '', duration: 1, timestamp: new Date(), fileCount: 0 },
      ...(status === 'error' || status === 'unavailable' ? { error: `${id}:${status}` } : {}),
    } satisfies ToolResult),
  };
}

function makeDeps(): { deps: ToolAdapterExecutorDeps; escalation: ReturnType<typeof vi.spyOn> } {
  const degradationManager = new DegradationManager();
  const escalation = vi.spyOn(degradationManager, 'escalate');
  const auditLogger = new AuditLogger();
  vi.spyOn(auditLogger, 'logToolExecution').mockResolvedValue(undefined);
  const deps: ToolAdapterExecutorDeps = {
    degradationManager,
    auditLogger,
    emitter: NOOP_EMITTER,
  };
  return { deps, escalation };
}

describe('ToolAdapterExecutor skipped/unavailable 语义分离（ADR #7 + C4 分域）', () => {
  it('Given 质量类工具（inspect）unavailable，When runAll，Then fail-open：passed=true + degraded=true，且不 escalate', async () => {
    const { deps, escalation } = makeDeps();
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['eslint', makeAdapter('eslint', 'inspect', 'unavailable')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(true);
    expect(results[0].degraded).toBe(true);
    expect(results[0].status).toBe('unavailable');
    expect(escalation).not.toHaveBeenCalled();
  });

  it('Given 安全类工具（security）unavailable，When runAll，Then fail-closed：passed=false + degraded=true，且不 escalate（覆盖率缺口而非故障）', async () => {
    const { deps, escalation } = makeDeps();
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['gitleaks', makeAdapter('gitleaks', 'security', 'unavailable')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(false);
    expect(results[0].degraded).toBe(true);
    expect(results[0].status).toBe('unavailable');
    expect(escalation).not.toHaveBeenCalled();
  });

  it('Given 工具返回 skipped（语言不适用），When runAll，Then 不计失败：passed=true 且不标记 degraded，status=skipped', async () => {
    const { deps, escalation } = makeDeps();
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['eslint', makeAdapter('eslint', 'inspect', 'skipped')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(true);
    expect(results[0].degraded).toBe(false);
    expect(results[0].status).toBe('skipped');
    expect(escalation).not.toHaveBeenCalled();
  });

  it('Given 工具返回 error，When runAll，Then 失败：passed=false、degraded 不标记，且 escalate 真实错误', async () => {
    const { deps, escalation } = makeDeps();
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['eslint', makeAdapter('eslint', 'inspect', 'error')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(false);
    expect(results[0].degraded).toBe(false);
    expect(escalation).toHaveBeenCalledWith('eslint:error', 'eslint');
  });

  it('Given 工具返回 available，When runAll，Then passed=true 且不标记 degraded', async () => {
    const { deps } = makeDeps();
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['eslint', makeAdapter('eslint', 'inspect', 'available')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(true);
    expect(results[0].degraded).toBe(false);
  });

  it('Given DegradationManager 降级跳过，When runAll，Then 走 skipped 路径：passed=true 且不标记 degraded', async () => {
    const { deps } = makeDeps();
    deps.degradationManager.setLevel(4); // level 3/4：全部工具跳过
    const executor = new ToolAdapterExecutor(deps);
    const adapters = new Map<string, ToolAdapter>([
      ['eslint', makeAdapter('eslint', 'inspect', 'available')],
    ]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(true);
    expect(results[0].degraded).toBe(false);
    expect(results[0].issueCount).toBe(0);
  });
});

describe('ToolAdapterExecutor 硬上限保护（防 CI 卡死）', () => {
  it('Given 适配器 scan 永不 settle，When runAll，Then 在硬上限内降级为 error 而非无限挂起', async () => {
    const { deps, escalation } = makeDeps();
    const executor = new ToolAdapterExecutor({ ...deps, hardTimeoutMs: 150 });
    const hanging: ToolAdapter = {
      meta: {
        id: 'hang',
        name: 'Hang',
        category: 'inspect',
        priority: 'P0',
        installMode: 'builtin',
        description: '',
        cliCommand: 'hang',
        homepage: '',
        license: 'MIT',
      },
      isAvailable: vi.fn().mockResolvedValue(true),
      scan: vi.fn().mockReturnValue(new Promise<ToolResult>(() => {})),
    };
    const adapters = new Map<string, ToolAdapter>([['hang', hanging]]);

    const results = await executor.runAll(adapters, 'proj-1');

    expect(results[0].passed).toBe(false);
    expect(escalation).toHaveBeenCalled();
  }, 5000);
});
