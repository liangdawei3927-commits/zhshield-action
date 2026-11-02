import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDomains,
  runDomain,
  STATIC_SCAN_DOMAINS,
  SCAN_CHAIN_DOMAINS,
  formatDomainRecord,
} from '../domains/run-domains';
import type { DomainExecutor } from '../domains/types';

/**
 * 按域建任务的无头驱动（《07》C5 / A13 / A14 前置）。
 *
 * 这里锁的是三件事，且每件都是**意图**而非实现细节：
 *   1. 逐域账本必须真实（耗时来自实际执行，不是估值）——A14 的"优化前后对比"靠它；
 *   2. 单域故障必须只污染自己（A13）——否则一个慢工具能把整轮结论打成"未覆盖"；
 *   3. 未提供执行器的域必须是 `not-run`（不是 0 分、不是通过）——C4/C5 的表示口径。
 */

/** 可控时钟：执行器按约定步进，账本耗时因此可断言 */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('runDomains — 分域账本', () => {
  it('逐域计时：durationMs 来自实际执行，sumMs 等于各域之和', async () => {
    const clock = fakeClock();
    const cost: Record<string, number> = { inspect: 120, security: 80 };
    const executors: Record<string, DomainExecutor> = {
      inspect: async () => {
        clock.advance(cost.inspect);
        return { report: { domain: 'inspect' }, status: 'ok' };
      },
      security: async () => {
        clock.advance(cost.security);
        return { report: { domain: 'security' }, status: 'partial', reason: '1 个工具不可用' };
      },
    };

    const ledger = await runDomains({
      repoRoot: '/tmp/project',
      domains: ['inspect', 'security'],
      executors,
      now: clock.now,
    });

    expect(ledger.records.map((r) => r.domain)).toEqual(['inspect', 'security']);
    expect(ledger.records[0].durationMs).toBe(cost.inspect);
    expect(ledger.records[1].durationMs).toBe(cost.security);
    expect(ledger.records[1].status).toBe('partial');
    expect(ledger.records[1].reason).toBe('1 个工具不可用');
    expect(ledger.sumMs).toBe(cost.inspect + cost.security);
    expect(ledger.concurrency).toBe(1);
    expect(ledger.repoRoot).toBe('/tmp/project');
  });

  it('单域抛错只把自己记为 unavailable，其余域照常完成（A13 域级隔离）', async () => {
    const clock = fakeClock();
    const ledger = await runDomains({
      repoRoot: '/tmp/project',
      domains: ['inspect', 'refactor', 'performance'],
      executors: {
        inspect: async () => {
          clock.advance(10);
          return { report: 'inspect-ok' };
        },
        refactor: async () => {
          throw new Error('AST 解析崩溃');
        },
        performance: async () => {
          clock.advance(20);
          return { report: 'perf-ok' };
        },
      },
      now: clock.now,
    });

    // 整体绝不 reject —— 一个域的异常不能把整轮流水线打红
    expect(ledger.records.map((r) => r.status)).toEqual(['ok', 'unavailable', 'ok']);
    expect(ledger.records[1].reason).toBe('AST 解析崩溃');
    expect(ledger.records[2].report).toBe('perf-ok');
    expect(ledger.records[0].report).toBe('inspect-ok');
  });

  it('超预算的域记为 unavailable + overBudget，后续域继续（§7.5 熔断）', async () => {
    const ledger = await runDomains({
      repoRoot: '/tmp/project',
      domains: ['inspect', 'security'],
      budgets: { inspect: 50 },
      executors: {
        inspect: () => new Promise((resolve) => setTimeout(() => resolve({ report: 'late' }), 200)),
        security: async () => ({ report: 'security-ok' }),
      },
      now: () => 0,
    });

    expect(ledger.records[0].status).toBe('unavailable');
    expect(ledger.records[0].overBudget).toBe(true);
    expect(ledger.records[0].reason).toContain('超过 50ms 预算');
    // 超时的域没有伪造报告；后续域不受牵连
    expect(ledger.records[0].report).toBeUndefined();
    expect(ledger.records[1].status).toBe('ok');
  });

  it('未提供执行器的域是 not-run（不是 0 分/满分），且区分"运行时域"与"需宿主注入"', async () => {
    const ledger = await runDomains({ repoRoot: '/tmp/project' });

    // 缺省跑静态扫描八域（预算表即清单）
    expect(ledger.records.map((r) => r.domain)).toEqual(STATIC_SCAN_DOMAINS);
    const techdebt = ledger.records.find((r) => r.domain === 'techdebt');
    expect(techdebt?.status).toBe('not-run');
    expect(techdebt?.durationMs).toBe(0);
    expect(techdebt?.reason).toContain('需调用方注入');

    const runtime = await runDomains({ repoRoot: '/tmp/project', domains: ['sentinel', 'backup'] });
    expect(runtime.records.map((r) => r.status)).toEqual(['not-run', 'not-run']);
    expect(runtime.records[0].reason).toContain('不属于静态扫描');
  });

  it('只跑单域时不产出其余域记录（C5：不得冒充 0 分或 100 分）', async () => {
    const record = await runDomain('performance', {
      repoRoot: '/tmp/project',
      executors: { performance: async () => ({ report: { id: 'perf' } }) },
    });
    expect(record.domain).toBe('performance');
    expect(record.status).toBe('ok');
    expect(record.report).toEqual({ id: 'perf' });
  });

  it('账本单行摘要可读（CLI / 日志口径）', () => {
    expect(
      formatDomainRecord({
        domain: 'security',
        status: 'unavailable',
        durationMs: 12_345,
        overBudget: true,
        reason: 'trivy 不可用',
      }),
    ).toBe('security unavailable 12.35s ⚠超预算 — trivy 不可用');
  });

  it('全量扫描链排除 guard：门禁是纯判定域，不参与扫描（A6/A12）', () => {
    expect(SCAN_CHAIN_DOMAINS).not.toContain('guard');
    expect(SCAN_CHAIN_DOMAINS).toHaveLength(STATIC_SCAN_DOMAINS.length - 1);
    // 其余域一个不少，避免"排除 guard"顺手漏掉别的域
    expect(STATIC_SCAN_DOMAINS.filter((domain) => domain !== 'guard')).toEqual([
      ...SCAN_CHAIN_DOMAINS,
    ]);
  });
});

describe('依赖域 CVE 前提（A15）', () => {
  /** 最小 npm v3 夹具：图谱只需要 package.json + package-lock.json */
  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'zh-deps-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }),
    );
    await writeFile(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-x', license: 'MIT' },
        },
      }),
    );
    return dir;
  }

  it('Given 漏洞库不可达，When 跑 deps 域，Then cve.status=unavailable、0 条 CVE 结论，且域记 partial', async () => {
    const dir = await makeProject();
    try {
      const record = await runDomain('deps', {
        repoRoot: dir,
        depsScanInput: {
          cveProvider: async () => ({
            status: 'unavailable',
            findings: [],
            reason: 'network unreachable',
            checkedAt: new Date().toISOString(),
          }),
        },
      });
      const report = record.report as {
        cve: { status: string; findings: unknown[]; reason?: string };
      };

      // 未检测 ≠ 0 漏洞：报告必须留痕，域状态不能是 ok
      expect(record.status).toBe('partial');
      expect(record.reason).toContain('漏洞库不可达');
      expect(report.cve.status).toBe('unavailable');
      expect(report.cve.findings).toEqual([]);
      expect(report.cve.reason).toBe('network unreachable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('Given 漏洞库可达且有命中，When 跑 deps 域，Then 结论计入报告、域状态 ok', async () => {
    const dir = await makeProject();
    try {
      const record = await runDomain('deps', {
        repoRoot: dir,
        depsScanInput: {
          cveProvider: async () => ({
            status: 'ok',
            findings: [
              {
                name: 'lodash',
                version: '4.17.21',
                ids: 'CVE-2021-23337',
                summary: '命令注入',
                severity: 'high' as const,
              },
            ],
            checkedAt: new Date().toISOString(),
          }),
        },
      });
      const report = record.report as { cve: { status: string; findings: unknown[] } };

      expect(record.status).toBe('ok');
      expect(report.cve.status).toBe('ok');
      expect(report.cve.findings).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
