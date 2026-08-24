// F5-3 集成测：真实 GitleaksAdapter 声明 scope → 注册点转发 → 内核 EventBus → sentinel 消费
// 覆盖两条生产接线：InspectEngine.registerAdapter（emitter 桥接，同 pipeline 做法）
// 与 SopRuleEngine.registerToolAdapter（自带 eventBus）。
import { describe, it, expect } from 'vitest';
import { InspectEngine } from '../engine';
import { GitleaksAdapter } from '../adapters/gitleaks-adapter';
import { EventBus, SopRegistry, SopRuleEngine } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import { EventCenter, subscribeScopeViolations } from '@zh/sentinel';
import type { EventEmitter, GovernanceEvent, ScopeViolationEvent, ToolAdapter, ToolId, ToolResult, ToolScanOptions } from '@zh/shared';

function makeCapturingEmitter(): { emitter: EventEmitter; events: GovernanceEvent[] } {
  const events: GovernanceEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event) => {
        events.push(event);
      },
    },
  };
}

function makeScopedMock(id: ToolId, accessScope: ToolAdapter['accessScope']): ToolAdapter & { scanCalls: ToolScanOptions[] } {
  const scanCalls: ToolScanOptions[] = [];
  const result: ToolResult = {
    tool: id,
    status: 'available',
    issues: [],
    metadata: { version: 'test', duration: 1, timestamp: new Date(), fileCount: 0 },
  };
  const adapter: ToolAdapter = {
    meta: {
      id,
      name: id,
      category: 'inspect',
      priority: 'P1',
      installMode: 'builtin',
      description: '',
      cliCommand: id,
      homepage: '',
      license: '',
    },
    ...(accessScope ? { accessScope } : {}),
    isAvailable: async () => true,
    scan: async (options) => {
      scanCalls.push(options);
      return result;
    },
  };
  return { ...adapter, scanCalls };
}

function makeToolDispatchRule(tool: ToolId): SopRule {
  return {
    id: `guard.block.wiring-${tool}`,
    name: 'wiring-test-rule',
    domain: 'guard',
    action: 'block',
    source: 'official',
    description: '',
    status: 'active',
    executionMode: 'sync',
    severity: 'high',
    applicableEngines: ['guard'],
    content: { check: { tool, toolConfig: {} } },
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const NODE_MODULES_TARGETS = ['node_modules/left-pad/index.js', 'src/app.ts'];

describe('F5-2 越界事件接线（warn-only）', () => {
  it('InspectEngine.registerAdapter：真实 gitleaks 收到 node_modules/** 入参 → 扫描照常执行且发出越界事件', async () => {
    const { emitter, events } = makeCapturingEmitter();
    const engine = new InspectEngine(emitter);
    engine.registerAdapter(new GitleaksAdapter());

    const wrapped = engine.getToolManager().get('gitleaks');
    const result = await wrapped.scan({
      projectPath: '/tmp/proj',
      projectId: 'proj-f5',
      targetFiles: NODE_MODULES_TARGETS,
    });

    expect(['available', 'unavailable', 'error']).toContain(result.status);
    const scopeEvents = events.filter((e): e is Extract<GovernanceEvent, { type: 'tool:scope-violation' }> => e.type === 'tool:scope-violation');
    expect(scopeEvents).toHaveLength(1);
    expect(scopeEvents[0]?.payload).toMatchObject({
      tool: 'gitleaks',
      projectId: 'proj-f5',
      file: 'node_modules/left-pad/index.js',
    });
    expect(scopeEvents[0]?.payload.reason).toBe('excluded-by-scope:**/node_modules/**');
  });

  it('InspectEngine 接线：范围内入参不产生越界事件', async () => {
    const { emitter, events } = makeCapturingEmitter();
    const engine = new InspectEngine(emitter);
    engine.registerAdapter(new GitleaksAdapter());

    await engine.getToolManager().get('gitleaks').scan({
      projectPath: '/tmp/proj',
      projectId: 'proj-f5',
      targetFiles: ['src/app.ts', '.env'],
    });

    expect(events.filter((e) => e.type === 'tool:scope-violation')).toHaveLength(0);
  });

  it('全链路：inspect 引擎 → 内核 EventBus → sentinel subscribeScopeViolations → EventCenter 告警', async () => {
    const bus = new EventBus();
    const center = new EventCenter();
    const unsubscribe = subscribeScopeViolations(bus, center);

    // 与 pipeline-runner 相同的 GovernanceEvent → EventBus 桥接
    const engine = new InspectEngine({
      emit: (event) => void bus.emit(event.type, event.payload),
    });
    engine.registerAdapter(new GitleaksAdapter());

    await engine.getToolManager().get('gitleaks').scan({
      projectPath: '/tmp/proj',
      projectId: 'proj-f5',
      targetFiles: NODE_MODULES_TARGETS,
    });

    const alerts = center.listEvents();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      projectId: 'proj-f5',
      service: 'gitleaks',
      module: 'tool-adapter',
      severity: 'p3',
    });
    expect(alerts[0]?.context).toMatchObject({
      kind: 'tool-scope-violation',
      file: 'node_modules/left-pad/index.js',
    });
    unsubscribe();
  });

  it('SopRuleEngine.registerToolAdapter：tool-dispatch 扫描入参越界 → 自带 eventBus 收到事件', async () => {
    const bus = new EventBus();
    const received: ScopeViolationEvent[] = [];
    bus.on<ScopeViolationEvent>('tool:scope-violation', (payload) => {
      received.push(payload);
    });

    const fake = makeScopedMock('eslint', {
      readPaths: ['**/*.{ts,js}'],
      excludePaths: ['**/node_modules/**'],
    });
    const registry = new SopRegistry();
    const engine = new SopRuleEngine(registry, { eventBus: bus });
    engine.registerToolAdapter('eslint', fake);
    registry.register(makeToolDispatchRule('eslint'));

    await engine.evaluateRules({ repoRoot: '/test-project', domain: 'guard', files: NODE_MODULES_TARGETS });

    expect(fake.scanCalls).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      tool: 'eslint',
      projectId: '/test-project',
      file: 'node_modules/left-pad/index.js',
      reason: 'excluded-by-scope:**/node_modules/**',
    });
  });
});
