import { describe, it, expect, beforeEach } from 'vitest';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * R7 归属让位：非本域 Owner 的规则在缺适配器时**不得**落 degraded。
 *
 * 背景（2026-11-11 实机）：`inspect.scan.external.dependency-audit` 在体检域每轮
 * 必 degraded（npm-audit / trivy / grype 均未注册适配器），而 O10 已把依赖审计
 * 唯一归 deps。degraded 的语义是「本该由本域跑却没跑成」，一条归 deps 的规则
 * 在体检域缺适配器属于**让位**，标 degraded 会让每轮扫描固定产出一条假降级、
 * 并永久拉低体检覆盖率（R6 口径）。
 */
describe('SopRuleEngine — R7 归属让位（缺适配器时不降级）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;

  beforeEach(() => {
    registry = new SopRegistry();
    // 不注册任何工具适配器：命中「未注册工具适配器」分支
    engine = new SopRuleEngine(registry, {});
  });

  it('归 deps 的依赖审计规则在体检域 → skipped 且 degraded 不置位', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.external.dependency-audit',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'npm-audit', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('deps');
    expect(evaluation.message).toContain('本域不重复评估');
    // 让位不计入降级数
    expect(report.degraded ?? 0).toBe(0);
  });

  it('本域自有规则缺适配器 → 仍落 skipped + degraded（不许静默通过）', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.internal.own-tool-rule',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { tool: 'not-registered-tool', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBe(true);
    expect(report.degraded).toBe(1);
  });

  it('scanner-dispatch 形态同样让位：scanners 全不可用但不标 degraded', async () => {
    // 2026-11-11 实机：dependency-audit 走的是 scanners 分支，只给 tool-dispatch 加让位不够
    registry.register(
      makeRule({
        id: 'inspect.scan.external.dependency-audit',
        domain: 'inspect',
        applicableEngines: ['inspect'],
        content: { check: { scanners: ['npm-audit', 'trivy', 'grype'] } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'inspect' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('deps');
    expect(report.degraded ?? 0).toBe(0);
  });

  it('归 refactor 的 duplicate-code 规则在安全域 → skipped 且 degraded 不置位', async () => {
    // 2026-11-11 实测：安全域这条规则 id 的末段是 `duplicate-code`（与归属表里的
    // `duplicated-code` 拼写不同），jscpd 未安装时每轮必 degraded。O1 已把重复代码
    // 唯一归重构 —— 缺工具是归属让位，不是安全域的故障。
    registry.register(
      makeRule({
        id: 'security.scan.internal.duplicate-code',
        domain: 'security',
        applicableEngines: ['security'],
        content: { check: { tool: 'jscpd', toolConfig: {} } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: '/tmp', domain: 'security' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('refactor');
    expect(report.degraded ?? 0).toBe(0);
  });

  it('适配器已注册但工具不可用 → 仍按归属让位，不标 degraded', async () => {
    // 2026-11-11 实机缺口：jscpd 适配器是注册过的，只是 PATH 里没有工具，于是走了
    // 「可用性检查」分支 —— 那里不判归属，duplicate-code 每轮都 degraded。让位判据
    // 收到求值入口后，这条不论适配器/工具处于什么状态都不再落降级。
    let scanned = 0;
    const jscpdAdapter = {
      meta: {
        id: 'jscpd' as const,
        name: 'jscpd',
        category: 'inspect' as const,
        priority: 'P2' as const,
        installMode: 'on-demand' as const,
        description: '',
        cliCommand: 'jscpd',
        homepage: '',
        license: '',
      },
      isAvailable: async () => false,
      scan: async () => {
        scanned += 1;
        throw new Error('让位规则不该启动工具进程');
      },
    };
    const engineWithAdapter = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'jscpd', adapter: jscpdAdapter }],
    });
    registry.register(
      makeRule({
        id: 'security.scan.internal.duplicate-code',
        domain: 'security',
        applicableEngines: ['security'],
        content: { check: { tool: 'jscpd', toolConfig: {} } },
      }),
    );

    const report = await engineWithAdapter.evaluateRules({ repoRoot: '/tmp', domain: 'security' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('refactor');
    expect(report.degraded ?? 0).toBe(0);
    expect(scanned).toBe(0);
  });

  it('适配器可用也不在非 Owner 域执行（归属即让位，不探测、不起进程）', async () => {
    // C3：非 Owner 域不重扫。以前只有「缺适配器」才让位，工具装好的机器上
    // 安全域仍会把这条重复代码规则真跑一遍 —— 结论与评分会与重构域打架。
    let availableProbes = 0;
    let scanned = 0;
    const jscpdAdapter = {
      meta: {
        id: 'jscpd' as const,
        name: 'jscpd',
        category: 'inspect' as const,
        priority: 'P2' as const,
        installMode: 'on-demand' as const,
        description: '',
        cliCommand: 'jscpd',
        homepage: '',
        license: '',
      },
      isAvailable: async () => {
        availableProbes += 1;
        return true;
      },
      scan: async () => {
        scanned += 1;
        throw new Error('让位规则不该启动工具进程');
      },
    };
    const engineWithAdapter = new SopRuleEngine(registry, {
      toolAdapters: [{ name: 'jscpd', adapter: jscpdAdapter }],
    });
    registry.register(
      makeRule({
        id: 'security.scan.internal.duplicate-code',
        domain: 'security',
        applicableEngines: ['security'],
        content: { check: { tool: 'jscpd', toolConfig: {} } },
      }),
    );

    const report = await engineWithAdapter.evaluateRules({ repoRoot: '/tmp', domain: 'security' });
    const evaluation = report.evaluations[0];

    expect(evaluation.status).toBe('skipped');
    expect(evaluation.degraded).toBeUndefined();
    expect(evaluation.message).toContain('refactor');
    expect(availableProbes).toBe(0);
    expect(scanned).toBe(0);
  });
});
