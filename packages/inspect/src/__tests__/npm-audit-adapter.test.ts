import { describe, it, expect } from 'vitest';
import { parseAuditVulnerabilities } from '../adapters/npm-audit-adapter';

/**
 * `parseAuditVulnerabilities` 的真相源优先级回归。
 *
 * 背景（2026-10-25）：pnpm 11 的 `audit.ignore` 只从 `advisories` 里剔除条目，
 * **不动 `metadata.vulnerabilities`**。旧实现只读 metadata ⇒ 在 pnpm 已判定
 * 「无待处理漏洞」（EXIT=0）时仍报「发现 1 个 moderate 级依赖漏洞」，
 * 该 issue 的 file 为空串 ⇒ `moduleOf('')` 落 `(root)` 桶 ⇒ 技术债面板
 * 持续再生伪债务项 `td-quality-44c4ce057952`（点开还没有对应文件）。
 */
describe('parseAuditVulnerabilities — advisories 优先于 metadata', () => {
  // ── 误报侧：忽略登记后必须归零 ────────────────────────────────────────
  it('advisories 为空（已登记 audit.ignore）+ metadata 仍报 1 moderate ⇒ 计 0 条', () => {
    // 实机抓包：pnpm 11.17.0 加了 audit.ignore 后的真实输出形状
    const raw = JSON.stringify({
      advisories: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
    });

    const vulns = parseAuditVulnerabilities(raw);

    expect(vulns).toEqual({});
    expect(vulns?.moderate ?? 0).toBe(0);
  });

  // ── 真阳性侧：有真实 advisory 时不能漏 ────────────────────────────────
  it('advisories 含 1 条 moderate ⇒ 计 1 条（未因上面的修复而漏报）', () => {
    // 实机抓包：同一 lockfile 去掉 ignore 后的真实输出形状
    const raw = JSON.stringify({
      advisories: {
        1105567: {
          module_name: 'postcss-selector-parser',
          severity: 'moderate',
          title: 'Quadratic complexity in flat selector parsing',
        },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } },
    });

    const vulns = parseAuditVulnerabilities(raw);

    expect(vulns).toEqual({ moderate: 1 });
  });

  it('多条 advisory 混合严重级 ⇒ 按 severity 正确分桶', () => {
    const raw = JSON.stringify({
      advisories: {
        1: { severity: 'critical' },
        2: { severity: 'high' },
        3: { severity: 'high' },
        4: { severity: 'moderate' },
        5: { severity: 'low' },
        6: { severity: 'info' },
      },
      metadata: { vulnerabilities: { info: 1, low: 1, moderate: 1, high: 2, critical: 1 } },
    });

    expect(parseAuditVulnerabilities(raw)).toEqual({
      critical: 1,
      high: 2,
      moderate: 1,
      low: 1,
      info: 1,
    });
  });

  it('advisories 里 severity 大小写不统一 / 未知取值 ⇒ 归一化并跳过未知项', () => {
    const raw = JSON.stringify({
      advisories: {
        1: { severity: 'MODERATE' },
        2: { severity: 'weird-value' },
        3: {},
      },
      metadata: { vulnerabilities: { moderate: 3 } },
    });

    expect(parseAuditVulnerabilities(raw)).toEqual({ moderate: 1 });
  });

  // ── 回退侧：npm 新版 JSON 没有 advisories ─────────────────────────────
  it('无 advisories 键（npm audit JSON）⇒ 回退 metadata.vulnerabilities', () => {
    const raw = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: { foo: { severity: 'high' } },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    });

    expect(parseAuditVulnerabilities(raw)).toEqual({
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
    });
  });

  // ── 失败侧：无法判定时返回 null，由调用方降级为 error ─────────────────
  it('非法 JSON ⇒ null', () => {
    expect(parseAuditVulnerabilities('not json at all')).toBeNull();
  });

  it('既无 advisories 也无 metadata.vulnerabilities ⇒ null', () => {
    expect(parseAuditVulnerabilities(JSON.stringify({ metadata: {} }))).toBeNull();
  });
});
