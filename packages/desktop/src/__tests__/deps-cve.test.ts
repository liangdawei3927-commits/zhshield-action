/**
 * P1-8 回归：CVE 检测不静默（deps-cve.test.ts）
 *
 * 缺陷：deps 引擎完全没有 CVE 检测，lodash@4.17.15 / axios@0.21.0 这类已知
 * CVE 版本恒显示 0/0/0——「没检测」被呈现成「安全」。
 *
 * 修复：OSV querybatch 在线查询（direct 依赖批量、8s 超时），不可达 →
 * status='unavailable'，dashboard/UI 必须显式标注「CVE 未检测」。
 * fetch 注入，单测无需真实网络。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  collectQueryableDeps,
  cveCounts,
  mapOsvSeverity,
  runCveChecks,
  vulnDisplayIds,
  vulnsToFindings,
} from '../../electron/ipc/deps-cve';

function fetchOk(results: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ results }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function fetchFail(status: number): typeof fetch {
  return vi.fn(async () => new Response('err', { status })) as unknown as typeof fetch;
}

describe('mapOsvSeverity / vulnDisplayIds — 解析纯函数', () => {
  it('GHSA database_specific 严重度映射：CRITICAL/HIGH/其余', () => {
    expect(mapOsvSeverity({ database_specific: { severity: 'CRITICAL' } })).toBe('critical');
    expect(mapOsvSeverity({ database_specific: { severity: 'HIGH' } })).toBe('high');
    expect(mapOsvSeverity({ database_specific: { severity: 'MODERATE' } })).toBe('medium');
    expect(mapOsvSeverity({})).toBe('medium'); // 无标注按 medium 兜底，宁高估不漏报
  });

  it('CVE 别名优先展示，主 id 与 CVE 去重合并', () => {
    expect(
      vulnDisplayIds({ id: 'GHSA-xxxx', aliases: ['CVE-2021-23337', 'CVE-2021-23337'] }),
    ).toBe('GHSA-xxxx, CVE-2021-23337');
    expect(vulnDisplayIds({ id: 'GHSA-yyyy' })).toBe('GHSA-yyyy');
  });

  it('vulnsToFindings：单依赖多漏洞逐条产出，版本/名称对齐', () => {
    const findings = vulnsToFindings(
      { name: 'lodash', version: '4.17.15' },
      [{ id: 'GHSA-a', aliases: ['CVE-2021-23337'], summary: 'cmd injection' }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      name: 'lodash',
      version: '4.17.15',
      severity: 'medium',
      summary: 'cmd injection',
    });
    expect(findings[0].ids).toContain('CVE-2021-23337');
  });
});

describe('collectQueryableDeps — 只查 direct、去重、截断', () => {
  it('排除 transitive，同名同版本去重', () => {
    const deps = collectQueryableDeps([
      { name: 'lodash', version: '4.17.15', kind: 'direct' },
      { name: 'lodash', version: '4.17.15', kind: 'transitive' },
      { name: 'lodash', version: '4.17.15', kind: 'direct' },
      { name: 'axios', version: '0.21.0', kind: 'direct' },
    ]);
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.name)).toEqual(['lodash', 'axios']);
  });

  it('无 kind 字段的节点也查（宽松输入）', () => {
    expect(collectQueryableDeps([{ name: 'a', version: '1.0.0' }])).toHaveLength(1);
    expect(collectQueryableDeps([{ name: '', version: '1.0.0' }])).toHaveLength(0);
  });
});

describe('runCveChecks — 在线查询与降级（P1-8 核心）', () => {
  const nodes = [
    { name: 'lodash', version: '4.17.15', kind: 'direct' },
    { name: 'axios', version: '0.21.0', kind: 'direct' },
  ];

  it('真阳性：OSV 可达 → status=ok，命中的 CVE 逐条产出', async () => {
    const fetchImpl = fetchOk([
      {
        vulns: [
          {
            id: 'GHSA-35jh-r3h4-6jhm',
            aliases: ['CVE-2021-23337'],
            summary: 'Command Injection',
            database_specific: { severity: 'HIGH' },
          },
        ],
      },
      {
        vulns: [
          {
            id: 'GHSA-w18p-er7q-jhn9',
            aliases: ['CVE-2022-0639'],
            summary: 'Server-Side Request Forgery',
            database_specific: { severity: 'MODERATE' },
          },
        ],
      },
    ]);
    const result = await runCveChecks(nodes, fetchImpl);
    expect(result.status).toBe('ok');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      name: 'lodash',
      severity: 'high',
      ids: expect.stringContaining('CVE-2021-23337'),
    });
    expect(result.findings[1].ids).toContain('CVE-2022-0639');
    // dashboard 计数随之产生
    expect(cveCounts(result)).toEqual({ critical: 0, high: 1, medium: 1 });
  });

  it('误报防护：OSV 返回空结果 → ok 且 0 findings（真查过没查到 ≠ 降级）', async () => {
    const result = await runCveChecks(nodes, fetchOk([{}, {}]));
    expect(result.status).toBe('ok');
    expect(result.findings).toHaveLength(0);
    expect(cveCounts(result)).toEqual({ critical: 0, high: 0, medium: 0 });
  });

  it('降级显形：HTTP 非 2xx → status=unavailable 且 reason 可见，计数恒 0', async () => {
    const result = await runCveChecks(nodes, fetchFail(503));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('503');
    expect(cveCounts(result)).toEqual({ critical: 0, high: 0, medium: 0 });
  });

  it('降级显形：网络异常（fetch 抛错）→ unavailable，不向上抛', async () => {
    const fail: typeof fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.osv.dev');
    }) as unknown as typeof fetch;
    const result = await runCveChecks(nodes, fail);
    expect(result.status).toBe('unavailable');
    expect(result.reason).toContain('ENOTFOUND');
  });

  it('降级显形：响应形状不符 → unavailable（不解析出假 0）', async () => {
    const bad: typeof fetch = vi.fn(async () =>
      new Response('{"unexpected": true}', { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await runCveChecks(nodes, bad);
    expect(result.status).toBe('unavailable');
  });

  it('0 个 direct 依赖 → ok + 空（不发起请求）', async () => {
    const fetchSpy = fetchOk([]);
    const result = await runCveChecks([], fetchSpy);
    expect(result.status).toBe('ok');
    expect(result.findings).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('结构守卫 — P1-8 链路接线（防改回去）', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const electronDir = path.resolve(__dirname, '../../electron');
  const read = (rel: string): string => fs.readFileSync(path.join(electronDir, rel), 'utf-8');

  it('runDepsHandler 把 CVE 作为第 5 路并行检查', () => {
    const src = read('ipc/engines-deps.ts');
    expect(src).toContain('runCveChecks(nodes)');
    expect(src).toContain('cve,'); // buildDepsReport 透传
    expect(src).toContain('cveCounts'); // dashboard patch 携带计数
  });

  it('deps 域诊断归一化产出 CVE 条目；unavailable 不产条目', () => {
    const src = read('zh-diagnostics-engines.ts');
    expect(src).toContain('cve:${finding.name}@${finding.version}');
    expect(src).toContain("data.cve?.findings ?? []");
  });

  it('dashboard 契约携带 cve.status（unavailable 必须随行）', () => {
    const src = read('ipc/dashboard-state.ts');
    expect(src).toMatch(/cve\?\s*:\s*\{\s*status/);
  });

  it('前端依赖页必须有 CVE 卡片且引用 unavailable 文案', () => {
    const parts = fs.readFileSync(
      path.resolve(__dirname, '../pages/dependency-parts.tsx'),
      'utf-8',
    );
    expect(parts).toContain('DependencyCveCard');
    expect(parts).toContain("t('page.deps.cve.unavailable')");
    const page = fs.readFileSync(path.resolve(__dirname, '../pages/DependencyPage.tsx'), 'utf-8');
    expect(page).toContain('<DependencyCveCard report={report} />');
  });
});

/**
 * 详情补拉回归（2026-10-27 实机验收发现）。
 *
 * OSV **querybatch 是精简响应**，每个命中只有 { id, modified }：
 * 不补 GET /v1/vulns/{id} 则 severity 恒落 medium 兜底、summary 为空、
 * CVE 别名缺失。实机跑 lodash@4.17.20 得到 6 条全 medium 且只有 GHSA 号，
 * 修复后同一输入为 critical:1 / high:2 / medium:3 并带 CVE-2021-23337 等别名。
 */
describe('OSV 详情补拉 — querybatch 精简响应必须补全', () => {
  const batchOnly = (ids: string[]): typeof fetch =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({ results: [{ vulns: ids.map((id) => ({ id, modified: '2024-01-01T00:00:00Z' })) }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

  /** 路由式 mock：批量走精简响应，详情走完整响应 */
  function routedFetch(
    batchIds: string[],
    details: Record<string, unknown>,
  ): { impl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const impl = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('querybatch')) {
        return new Response(
          JSON.stringify({ results: [{ vulns: batchIds.map((id) => ({ id })) }] }),
          { status: 200 },
        );
      }
      const id = decodeURIComponent(url.split('/vulns/')[1] ?? '');
      const body = details[id];
      if (!body) return new Response('nf', { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('补拉后 severity / summary / CVE 别名全部到位', async () => {
    const { impl } = routedFetch(['GHSA-35jh-r3h4-6jhm'], {
      'GHSA-35jh-r3h4-6jhm': {
        id: 'GHSA-35jh-r3h4-6jhm',
        aliases: ['CVE-2021-23337'],
        summary: 'Command Injection in lodash',
        database_specific: { severity: 'HIGH' },
      },
    });
    const res = await runCveChecks([{ name: 'lodash', version: '4.17.20', kind: 'direct' }], impl);
    expect(res.status).toBe('ok');
    expect(res.findings[0].severity).toBe('high');
    expect(res.findings[0].summary).toBe('Command Injection in lodash');
    expect(res.findings[0].ids).toContain('CVE-2021-23337');
  });

  it('详情拉取失败 → 保留精简数据（漏洞不丢），severity 落 medium 兜底', async () => {
    const { impl } = routedFetch(['GHSA-29mw-wpgm-hmr9'], {}); // 详情全 404
    const res = await runCveChecks([{ name: 'lodash', version: '4.17.20', kind: 'direct' }], impl);
    expect(res.status).toBe('ok');
    expect(res.findings).toHaveLength(1); // 命中没被丢弃
    expect(res.findings[0].ids).toBe('GHSA-29mw-wpgm-hmr9');
    expect(res.findings[0].severity).toBe('medium');
  });

  it('补拉有上限：命中远超上限时详情请求 ≤ 30，其余保留精简数据', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `GHSA-aaaa-bbbb-${String(i).padStart(4, '0')}`);
    const details = Object.fromEntries(
      ids.map((id) => [id, { id, aliases: ['CVE-2020-0001'], summary: 'x', database_specific: { severity: 'CRITICAL' } }]),
    );
    const { impl, calls } = routedFetch(ids, details);
    const res = await runCveChecks([{ name: 'pkg', version: '1.0.0', kind: 'direct' }], impl);
    expect(res.status).toBe('ok');
    expect(res.findings).toHaveLength(40); // 一条不丢
    const detailCalls = calls.filter((u) => u.includes('/vulns/'));
    expect(detailCalls.length).toBe(30);
    expect(res.findings.filter((f) => f.severity === 'critical')).toHaveLength(30);
    expect(res.findings.filter((f) => f.severity === 'medium')).toHaveLength(10);
  });

  it('全部无漏洞时一次详情请求都不发（零开销快路径）', async () => {
    const impl = batchOnly([]);
    const res = await runCveChecks([{ name: 'left-pad', version: '1.3.0', kind: 'direct' }], impl);
    expect(res.status).toBe('ok');
    expect(res.findings).toHaveLength(0);
    expect((impl as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
  });
});
