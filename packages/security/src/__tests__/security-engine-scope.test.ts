// F5 权限边界集成测：SecurityEngine.registerAdapter 越界转发 → 内核 EventBus → sentinel 消费
import { describe, it, expect } from 'vitest';
import { SecurityEngine } from '../engine';
import { EventBus } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';
import type { ToolAdapter, ToolId, ToolResult } from '@zh/shared';

function makeScopedStub(id: ToolId): ToolAdapter {
  const result: ToolResult = {
    tool: id,
    status: 'available',
    issues: [],
    metadata: { version: 'test', duration: 1, timestamp: new Date(), fileCount: 0 },
  };
  return {
    meta: {
      id,
      name: id,
      category: 'security',
      priority: 'P1',
      installMode: 'builtin',
      description: '',
      cliCommand: id,
      homepage: '',
      license: '',
    },
    accessScope: { excludePaths: ['**/node_modules/**'] },
    isAvailable: async () => true,
    scan: async () => result,
  };
}

describe('F5 SecurityEngine 越界事件接线（warn-only）', () => {
  it('registerAdapter + kernel EventBus + sentinel consumer：node_modules 入参 → 恰好一条 ScopeViolationEvent 进入 EventCenter', async () => {
    const bus = new EventBus();
    const center = new EventCenter();
    const unsubscribe = subscribeScopeViolations(bus, center);

    // 与 pipeline-runner 相同的 GovernanceEvent → EventBus 桥接
    const engine = new SecurityEngine({
      emit: (event) => void bus.emit(event.type, event.payload),
    });
    engine.registerAdapter(makeScopedStub('semgrep'));

    await engine
      .getToolManager()
      .get('semgrep')
      .scan({
        projectPath: '/tmp/proj',
        projectId: 'proj-f5-security',
        targetFiles: ['node_modules/left-pad/index.js'],
      });

    const alerts = center.listEvents();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      projectId: 'proj-f5-security',
      service: 'semgrep',
      module: 'tool-adapter',
      severity: 'p3',
    });
    expect(alerts[0]?.context).toMatchObject({
      kind: 'tool-scope-violation',
      file: 'node_modules/left-pad/index.js',
      reason: 'excluded-by-scope:**/node_modules/**',
    });
    unsubscribe();
  });

  it('范围内入参不产生越界事件', async () => {
    const bus = new EventBus();
    const center = new EventCenter();
    const unsubscribe = subscribeScopeViolations(bus, center);

    const engine = new SecurityEngine({
      emit: (event) => void bus.emit(event.type, event.payload),
    });
    engine.registerAdapter(makeScopedStub('semgrep'));

    await engine
      .getToolManager()
      .get('semgrep')
      .scan({
        projectPath: '/tmp/proj',
        projectId: 'proj-f5-security',
        targetFiles: ['src/app.ts'],
      });

    expect(center.listEvents()).toHaveLength(0);
    unsubscribe();
  });
});
