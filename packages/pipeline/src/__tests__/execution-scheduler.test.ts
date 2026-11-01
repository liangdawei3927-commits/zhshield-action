/**
 * Scheduler（执行层调度，迁移第 8 步）验收测试。
 *
 * 覆盖《07》§7.4 / §7.5 与验收判据：
 *   · A12 同一 `(tool, targets, args)` 一次全量运行只起一个进程；
 *   · C1/C2 结果按 owner 广播，非 owner 申请方拿不到别人的 issue；
 *   · A13 单域工具超时/报错不拖垮其他域；
 *   · 域级预算耗尽 → 该域 unavailable，其余域继续；
 *   · A15 `requires`（network/db）不可达 → skipped，不起进程、不进 issues。
 */
import { describe, it, expect } from 'vitest';
import { Scheduler } from '../execution/scheduler';
import type { DomainPlan } from '../execution/scheduler';
import type { RoutableFinding } from '../execution/router';

type F = RoutableFinding;

const finding = (ruleId: string, fingerprint: string): F => ({ ruleId, fingerprint });

describe('Scheduler 合并执行（A12 / C1 / C2）', () => {
  it('Given 两个域各申请同一工具同一批目标，When 调度，Then 只起一个进程且 issue 只归 owner', async () => {
    const scheduler = new Scheduler();
    let runs = 0;
    const run = async (): Promise<readonly F[]> => {
      runs += 1;
      return [finding('security.scan.official.injection', 'inj:1')];
    };
    const plans: DomainPlan<F>[] = [
      { domain: 'inspect', requests: [{ tool: 'semgrep', targets: ['src/a.ts', 'src/b.ts'], run }] },
      { domain: 'security', requests: [{ tool: 'semgrep', targets: ['src/b.ts', 'src/a.ts'], run }] },
    ];

    const result = await scheduler.run(plans);

    expect(runs).toBe(1);
    expect(scheduler.invocationCount('semgrep')).toBe(1);
    expect(result.domains[0]?.tools[0]?.reused).toBe(false);
    expect(result.domains[1]?.tools[0]?.reused).toBe(true);
    // 申请方 inspect 不是 owner → 不拿 security 的 issue（不重复计分）
    expect(result.domains[0]?.findings).toEqual([]);
    expect(result.domains[1]?.findings).toHaveLength(1);
    expect(result.distribution).toEqual([
      { ruleId: 'security.scan.official.injection', owner: 'security', fingerprint: 'inj:1' },
    ]);
  });

  it('Given 某工具同时产出两域结论，When 其中一域未申请该工具，Then 该域仍收到自己的结论（广播，工具数为 0）', async () => {
    const scheduler = new Scheduler();
    const run = async (): Promise<readonly F[]> => [
      finding('security.scan.official.injection', 'inj:1'),
      finding('inspect.scan.official.style', 'style:1'),
    ];
    const plans: DomainPlan<F>[] = [
      { domain: 'inspect', requests: [{ tool: 'semgrep', targets: ['src/a.ts'], run }] },
    ];

    const result = await scheduler.run(plans);

    expect(result.domains.map((d) => d.domain)).toEqual(['inspect', 'security']);
    expect(result.domains[0]?.findings).toHaveLength(1);
    expect(result.domains[1]?.tools).toEqual([]);
    expect(result.domains[1]?.findings).toHaveLength(1);
  });
});

describe('Scheduler 熔断（A13 / §7.5）', () => {
  it('Given deps 域工具挂死、inspect 域工具正常，When 调度，Then 仅 deps 记超时，inspect 照常出结论', async () => {
    const scheduler = new Scheduler({ hardTimeouts: { trivy: 20 } });
    const neverResolves = () => new Promise<readonly F[]>(() => {});
    const plans: DomainPlan<F>[] = [
      { domain: 'deps', requests: [{ tool: 'trivy', targets: ['pnpm-lock.yaml'], run: neverResolves }] },
      {
        domain: 'inspect',
        requests: [
          {
            tool: 'tsc',
            targets: ['src/a.ts'],
            run: async () => [finding('inspect.scan.official.type-safety', 'ts:1')],
          },
        ],
      },
    ];

    const result = await scheduler.run(plans);

    const deps = result.domains[0];
    expect(deps?.tools[0]?.status).toBe('timeout');
    expect(deps?.status).toBe('unavailable');
    expect(deps?.findings).toEqual([]);

    const inspect = result.domains[1];
    expect(inspect?.status).toBe('ok');
    expect(inspect?.tools[0]?.status).toBe('ok');
    expect(inspect?.findings).toHaveLength(1);
  });

  it('Given 域级预算耗尽，When 仍有未执行的工具，Then 该域 unavailable 且后续工具不起进程，其他域继续', async () => {
    let clock = 0;
    const scheduler = new Scheduler({ budgets: { security: 100 }, now: () => (clock += 50) });
    const plans: DomainPlan<F>[] = [
      {
        domain: 'security',
        requests: [
          {
            tool: 'semgrep',
            targets: ['src/a.ts'],
            run: async () => [finding('security.scan.official.injection', 'inj:1')],
          },
          {
            tool: 'gitleaks',
            targets: ['src/a.ts'],
            run: async () => [finding('security.scan.official.secrets', 'sec:1')],
          },
        ],
      },
      {
        domain: 'garbage',
        requests: [{ tool: 'depcheck', targets: ['package.json'], run: async () => [] }],
      },
    ];

    const result = await scheduler.run(plans);

    const security = result.domains[0];
    expect(security?.status).toBe('unavailable');
    expect(security?.reason).toContain('预算');
    expect(security?.tools[1]?.status).toBe('skipped');
    expect(scheduler.invocationCount('gitleaks')).toBe(0);
    // 已得到的结论不因预算耗尽被丢弃
    expect(security?.findings).toHaveLength(1);

    expect(result.domains[1]?.status).toBe('ok');
    expect(scheduler.invocationCount('depcheck')).toBe(1);
  });
});

describe('Scheduler 运行前提与降级（A15 / Rule 12）', () => {
  it('Given network/db 不可达，When 工具声明了该前提，Then 记 skipped 且不起进程', async () => {
    let runs = 0;
    const scheduler = new Scheduler({ isRequirementAvailable: (req) => req !== 'db' });
    const plans: DomainPlan<F>[] = [
      {
        domain: 'deps',
        requests: [
          {
            tool: 'trivy',
            targets: ['pnpm-lock.yaml'],
            run: async () => {
              runs += 1;
              return [];
            },
          },
        ],
      },
    ];

    const result = await scheduler.run(plans);

    expect(runs).toBe(0);
    expect(result.domains[0]?.tools[0]?.status).toBe('skipped');
    expect(result.domains[0]?.tools[0]?.reason).toContain('db');
    expect(result.domains[0]?.findings).toEqual([]);
    expect(result.domains[0]?.status).toBe('unavailable');
  });

  it('Given 工具未在能力注册表登记，When 调度，Then 记 skipped 并给出原因（不静默跳过）', async () => {
    const scheduler = new Scheduler();
    const plans: DomainPlan<F>[] = [
      { domain: 'inspect', requests: [{ tool: 'prettier', targets: ['src/a.ts'], run: async () => [] }] },
    ];

    const result = await scheduler.run(plans);

    expect(result.domains[0]?.tools[0]?.status).toBe('skipped');
    expect(result.domains[0]?.tools[0]?.reason).toContain('能力注册表');
  });

  it('Given 单域工具抛错，When 调度，Then 该域 unavailable 但 run 不抛出，其他域不受影响', async () => {
    const scheduler = new Scheduler();
    const plans: DomainPlan<F>[] = [
      {
        domain: 'refactor',
        requests: [
          {
            tool: 'jscpd',
            targets: ['src/a.ts'],
            run: async () => {
              throw new Error('jscpd boom');
            },
          },
        ],
      },
      { domain: 'garbage', requests: [{ tool: 'ts-prune', targets: ['src/a.ts'], run: async () => [] }] },
    ];

    const result = await scheduler.run(plans);

    expect(result.domains[0]?.tools[0]?.status).toBe('error');
    expect(result.domains[0]?.tools[0]?.reason).toContain('jscpd boom');
    expect(result.domains[0]?.status).toBe('unavailable');
    expect(result.domains[1]?.status).toBe('ok');
  });
});
