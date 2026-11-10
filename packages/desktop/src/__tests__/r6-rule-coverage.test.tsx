/**
 * R6 验收（渲染侧）：规则级覆盖度。
 *
 * 锁四件事：
 * 1) RuleEngineReport → RuleCoverage 的逐条计数（error/skipped 计未执行，not-applicable 计已求值）；
 * 2) 规则分档之和与 total 对不上时，差额并入 unavailable（少算的规则也是没跑）；
 * 3) 评分卡 partial 时改口「已检测部分均分」+「覆盖 13/20 · 7 项未检测」，不出现等级/「优秀」；
 * 4) 总分视图把维度内部缺口并入 complete，并列出 partialDimensions。
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { I18nProvider } from '../i18n';
import { DomainScoreCard } from '../components/DomainScoreCard';
import { overviewRowInput } from '../pages/category-score-logic';
import { extractInspectRuleCoverage } from '../../electron/zh-diagnostics-normalize';
import { buildScanRecord } from '../../electron/domain-history';

vi.stubGlobal('navigator', { language: 'zh-Hans' });

// 评分卡的分数来自 IPC 钩子；本用例只验覆盖阈值，固定一个「98 / 优秀」的已评分视图
vi.mock('../hooks/useDomainScoreView', () => ({
  useDomainScoreView: () => ({
    kind: 'scored',
    scoreText: '98',
    color: 'rgb(var(--zh-success))',
    label: '优秀',
    ageHours: 0,
  }),
}));

const renderCard = (props: Parameters<typeof DomainScoreCard>[0]): string =>
  renderToStaticMarkup(
    (
      <I18nProvider>
        <DomainScoreCard {...props} />
      </I18nProvider>
    ) as ReactElement,
  );

function evaluation(status: string, applicability?: 'not-applicable') {
  return { rule: { id: 'rule', name: 'rule' }, status, ...(applicability ? { applicability } : {}) };
}

function ruleEngineReport(evaluations: unknown[], total?: number) {
  return {
    total: total ?? evaluations.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    ok: false,
    evaluations,
    durationMs: 0,
    timestamp: '2026-11-10T00:00:00.000Z',
  } as unknown as Parameters<typeof extractInspectRuleCoverage>[0];
}

describe('extractInspectRuleCoverage', () => {
  it('12 pass + 1 fail + 2 error + 5 skipped → 已求值 13 / 未执行 7', () => {
    const evaluations = [
      ...Array.from({ length: 12 }, () => evaluation('passed')),
      evaluation('failed'),
      ...Array.from({ length: 2 }, () => evaluation('error')),
      ...Array.from({ length: 5 }, () => evaluation('skipped')),
    ];
    expect(extractInspectRuleCoverage(ruleEngineReport(evaluations))).toEqual({
      total: 20,
      evaluated: 13,
      unavailable: 7,
      notApplicable: 0,
      complete: false,
    });
  });

  it('not-applicable 计入 evaluated，不构成覆盖缺口', () => {
    const evaluations = [
      evaluation('passed', 'not-applicable'),
      evaluation('passed', 'not-applicable'),
      evaluation('passed', 'not-applicable'),
      ...Array.from({ length: 17 }, () => evaluation('passed')),
    ];
    expect(extractInspectRuleCoverage(ruleEngineReport(evaluations))).toEqual({
      total: 20,
      evaluated: 20,
      unavailable: 0,
      notApplicable: 3,
      complete: true,
    });
  });

  it('total 大于 evaluations 数：差额并入 unavailable（少算的规则也是没跑）', () => {
    const evaluations = [
      ...Array.from({ length: 12 }, () => evaluation('passed')),
      evaluation('failed'),
    ];
    const coverage = extractInspectRuleCoverage(ruleEngineReport(evaluations, 20))!;
    expect(coverage.evaluated).toBe(13);
    expect(coverage.unavailable).toBe(7);
    expect(coverage.complete).toBe(false);
  });

  it('旧版 InspectionReport（无 evaluations）→ 覆盖未知（undefined）', () => {
    expect(
      extractInspectRuleCoverage({ issues: [] } as unknown as Parameters<
        typeof extractInspectRuleCoverage
      >[0]),
    ).toBeUndefined();
  });
});

describe('域历史 record 覆盖账', () => {
  it('buildScanRecord 透传 ruleCoverage（历史行据此标「部分」）', () => {
    const record = buildScanRecord({
      domain: 'inspect',
      scannedAt: '2026-11-10T04:35:29.000Z',
      recordedAt: '2026-11-10T04:35:30.000Z',
      projectPath: '/p',
      issues: [],
      score: 98,
      ruleCoverage: {
        total: 20,
        evaluated: 13,
        unavailable: 7,
        notApplicable: 0,
        complete: false,
      },
    });
    expect(record.ruleCoverage).toEqual({
      total: 20,
      evaluated: 13,
      unavailable: 7,
      notApplicable: 0,
      complete: false,
    });
  });
});

describe('DomainScoreCard 覆盖口径', () => {
  it('partial：改口「已检测部分均分」+ 覆盖徽章，不出现「优秀」', () => {
    const html = renderCard({
      projectPath: '/p',
      dimension: 'quality',
      coverage: { run: 13, total: 20 },
    });
    expect(html).toContain('已检测部分均分');
    expect(html).toContain('覆盖 13/20');
    expect(html).toContain('7 项未检测');
    expect(html).not.toContain('优秀');
  });

  it('complete：保留等级，并标覆盖 20/20', () => {
    const html = renderCard({
      projectPath: '/p',
      dimension: 'quality',
      coverage: { run: 20, total: 20 },
    });
    expect(html).toContain('优秀');
    expect(html).toContain('覆盖 20/20');
    expect(html).not.toContain('已检测部分均分');
  });

  it('quality 旧快照无规则账：显示「覆盖未知（旧口径）」，不冒充等级', () => {
    const html = renderCard({ projectPath: '/p', dimension: 'quality' });
    expect(html).toContain('覆盖未知（旧口径）');
    expect(html).not.toContain('优秀');
  });

  it('非 quality 维缺 coverage：保持原有等级展示', () => {
    const html = renderCard({ projectPath: '/p', dimension: 'security' });
    expect(html).toContain('优秀');
    expect(html).not.toContain('覆盖未知');
  });
});

describe('overviewRowInput 维度内部缺口', () => {
  const dimensions = [
    { name: 'quality', score: 98, status: 'scored' as const, coverage: { run: 13, total: 20, complete: false } },
    { name: 'gate', score: 100, status: 'scored' as const },
    { name: 'security', score: 100, status: 'scored' as const },
    { name: 'dependencies', score: 100, status: 'scored' as const },
    { name: 'garbage', score: 100, status: 'scored' as const },
    { name: 'performance', score: 100, status: 'scored' as const },
    { name: 'techdebt', score: 100, status: 'scored' as const },
    { name: 'refactor', score: 100, status: 'scored' as const },
    { name: 'sentinel', score: 100, status: 'scored' as const },
    { name: 'backup', score: 100, status: 'scored' as const },
  ];

  it('9 类全跑但 quality 内部有缺口 → complete=false + partialDimensions', () => {
    const result = overviewRowInput({
      overall: 98,
      dimensions,
      readAt: '2026-11-10T00:00:00.000Z',
    });
    expect(result.overall.partial.run).toBe(9);
    expect(result.overall.partial.total).toBe(9);
    expect(result.overall.complete).toBe(false);
    expect(result.overall.partialDimensions).toEqual(['quality']);
  });

  it('维度内部同样完整 → complete=true', () => {
    const result = overviewRowInput({
      overall: 99,
      dimensions: dimensions.map((d) =>
        d.name === 'quality'
          ? { ...d, coverage: { run: 20, total: 20, complete: true } }
          : d,
      ),
      readAt: '2026-11-10T00:00:00.000Z',
    });
    expect(result.overall.complete).toBe(true);
    expect(result.overall.partialDimensions).toBeUndefined();
  });
});
