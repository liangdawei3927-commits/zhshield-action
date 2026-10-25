/**
 * 统计卡「可点击性」契约 —— 锁两件会被用户直接看见的事：
 *
 * 1) 三张统计卡（代码异味 / 需重构文件 / 高优先级）**必须带 `detail`**。
 *    `ReportShell` 是否把卡片渲染成 button、是否挂 onClick，完全由
 *    `Boolean(stat.detail)` 决定。曾经重构页三张卡都没传 detail，卡片长得像能点、
 *    鼠标还是手型，点下去毫无反应 —— 这是"假交互"，不是"没实现"。
 *
 * 2) **没有 detail 的卡不得带手型与 hover 高亮**。此前 `cursor-pointer` 与
 *    `hover:border-brand-600 hover:shadow-md` 写在 className 常量里，对所有卡恒定
 *    生效，于是不可点的卡也在骗用户去点。
 *
 * 3) 高优先级卡的**明细条数必须等于卡上数字**（同源：文件级 critical/high），
 *    否则点开是"数字 3、列表 5"的新一轮不一致。
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ReportShell, type ReportStatCard } from '../components/business/ReportShell';
import { refactorReportStats } from '../pages/RefactorPage';
import type { RefactorReportData } from '../types/electron';

// node 环境 navigator.language 为 en-US；固定中文，断言才锚得住文案
vi.stubGlobal('navigator', { language: 'zh-Hans' });

function smell(ruleId: string, line: number, severity: 'error' | 'warning') {
  return {
    id: `${ruleId}-${line}`,
    ruleId,
    category: 'code-smell',
    severity,
    message: `${ruleId} at ${line}`,
    location: { filePath: 'src/a.ts', line, column: 1, endLine: line, endColumn: 2 },
    context: { metric: 'lines', value: 120, threshold: 80 },
    suggestion: {
      type: 'extract-method',
      description: '拆小函数',
      priority: 'high' as const,
      effort: 'small' as const,
      autoFixable: false,
    },
  };
}

/** 3 个文件：critical 1 + high 1 + low 1（共 4 处异味） */
const REPORT: RefactorReportData = {
  timestamp: '2026-10-25T08:00:00.000Z',
  projectRoot: '/tmp/project',
  totalFiles: 3,
  scannedFiles: 3,
  totalSmells: 4,
  byCategory: {},
  bySeverity: { error: 2, warning: 2 },
  files: [
    {
      filePath: 'src/a.ts',
      totalSmells: 2,
      maintainabilityScore: 41,
      refactorPriority: 'critical',
      smells: [smell('long-method', 10, 'error'), smell('deep-nesting', 42, 'warning')],
    },
    {
      filePath: 'src/b.ts',
      totalSmells: 1,
      maintainabilityScore: 62,
      refactorPriority: 'high',
      smells: [smell('duplicated-code', 7, 'error')],
    },
    {
      filePath: 'src/c.ts',
      totalSmells: 1,
      maintainabilityScore: 88,
      refactorPriority: 'low',
      smells: [smell('lazy-class', 3, 'warning')],
    },
  ],
  summary: { criticalFiles: 1, needsImmediateAction: 2, suggestionsByType: {} },
};

/** t 替身：只关心键是否被取用，不关心译文 */
const t = ((key: string) => key) as never;

function statsOfReport(): ReportStatCard[] {
  return refactorReportStats(t, REPORT, (() => undefined) as never);
}

describe('重构页统计卡：必须可点击', () => {
  it('三张卡都带 detail（缺一张就是点了没反应）', () => {
    const stats = statsOfReport();
    expect(stats.map((s) => s.key)).toEqual(['smells', 'files', 'highPriority']);
    for (const stat of stats) {
      expect(stat.detail, `${stat.key} 卡缺 detail ⇒ 渲染成不可点 div`).toBeTruthy();
      expect(typeof stat.detail?.render).toBe('function');
    }
  });

  it('明细条数与卡上数字同源（高优先级 = 文件级 critical/high）', () => {
    const [smells, files, highPriority] = statsOfReport();
    expect(smells.detail?.items.length).toBe(REPORT.totalSmells);
    expect(files.detail?.items.length).toBe(REPORT.files.length);
    expect(highPriority.value).toBe(REPORT.summary.needsImmediateAction);
    expect(highPriority.detail?.items.length).toBe(highPriority.value);
  });
});

describe('统计卡可点击性由 detail 决定，且不可点卡不得伪装', () => {
  const withDetail: ReportStatCard = {
    key: 'clickable',
    label: '有明细',
    value: 1,
    detail: { items: [1], render: () => null },
  };
  const withoutDetail: ReportStatCard = { key: 'static', label: '无明细', value: 2 };

  function renderShell(stats: ReportStatCard[]): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ReportShell
          projectPath="/tmp/project"
          dimension="refactor"
          icon={<span />}
          title="重构"
          score={<span>score</span>}
          action={<button type="button">rescan</button>}
          onBackHome={() => undefined}
          stats={stats}
        />
      </I18nProvider>,
    );
  }

  it('有 detail → button 且标记可点', () => {
    const html = renderShell([withDetail]);
    expect(html).toContain('data-stat-key="clickable"');
    expect(html).toContain('data-stat-clickable="true"');
    expect(html).toContain('<button');
  });

  it('无 detail → 非按钮语义、标记不可点、且不带手型与 hover 高亮', () => {
    const html = renderShell([withoutDetail]);
    expect(html).toContain('data-stat-clickable="false"');
    expect(html).not.toContain('data-stat-clickable="true"');
    // className 在 data-stat-key 之前输出，切片必须从该卡的**开标签**起，
    // 否则拿到的是后半段 HTML，手型类永远断言不到（变异测试曾因此假绿）。
    const anchor = html.indexOf('data-stat-key="static"');
    const cardMarkup = html.slice(html.lastIndexOf('<div', anchor), html.indexOf('</div>', anchor));
    expect(cardMarkup).toContain('class=');
    expect(cardMarkup).not.toContain('cursor-pointer');
    expect(cardMarkup).not.toContain('hover:border-brand-600');
  });
});
