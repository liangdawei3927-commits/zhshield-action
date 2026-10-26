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
