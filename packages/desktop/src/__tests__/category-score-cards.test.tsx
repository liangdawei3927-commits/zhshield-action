/**
 * 报告中心「评分总览」一行：首格总分 + 后接十张分类卡。
 *
 * 锁九件事（每条都对应一个会被用户直接看见的错误）：
 * 1) 卡片的**顺序**必须等于顶部导航顺序 —— 用户拿这行当导航用，错位就是点错分类；
 * 2) 分类 ↔ 评分维度必须是**双射**：既不能两个分类抢同一维度，也不能有维度没卡；
 * 3) 卡片标题用**导航文案**（「项目体检」而不是「质量」），看到的与点进去的一致；
 * 4) 未检测 → 「—」+「未检测」，不得显示 0 分（与 dimensionView 同口径）；
 * 5) 汇总记录缺该维（老记录只跑了 5 个域）→ 「—」+「暂无评分」，同样不得当 0；
 * 6) 真 0 分必须如实显示 0，不能被反向吞成「未检测」；
 * 7) 陈旧数据（>24h）必须标出来，不把一周前的分当当前状态；
 * 8) **总分卡在第一格且不可点击** —— 它不属于任何分类，做成按钮却无效果是假交互；
 * 9) 精简排版不得吞掉信息：陈旧、覆盖范围、红线封顶三条提示必须还在（都不出现时整条不渲染）；
 * 10) 卡片上方不再挂趋势图 / 常驻「数据时间」/ 操作提示 —— 分数已摆在卡上，重复信息抢视线。
 *
 * 点击行为在 node 环境无法真实触发 handle（无 DOM），故用**结构断言**兜底：
 * 分类卡必须是 button、带 data-nav-target，且组件里点击只调 navigate(card.navId)。
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { HEALTH_SCORE_DIMENSIONS } from '@zh/shared';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navItems } from '../components/layout/nav-items';
import { ScoreOverviewRow, type OverallScoreInput } from '../pages/category-score-cards';
import { categoryScoreCards, navIdForDimension } from '../pages/category-score-logic';

// node 环境 navigator.language 为 en-US，固定中文，断言才锚得住文案
vi.stubGlobal('navigator', { language: 'zh-Hans' });

const GENERATED_AT = '2026-10-23T11:02:00.000Z';
const NOW = new Date('2026-10-23T12:00:00.000Z').getTime();

/** 十域全跑过的汇总记录（每维一个可辨识的分） */
const FULL_DIMENSIONS = [
  { name: 'quality', score: 91, weight: 0.16, status: 'scored' as const },
  { name: 'gate', score: 0, weight: 0.08, status: 'scored' as const },
  { name: 'sentinel', score: 0, weight: 0.07, status: 'not-run' as const },
  { name: 'security', score: 88, weight: 0.16, status: 'scored' as const },
  { name: 'dependencies', score: 77, weight: 0.12, status: 'scored' as const },
  { name: 'garbage', score: 66, weight: 0.06, status: 'scored' as const },
  { name: 'performance', score: 83, weight: 0.09, status: 'scored' as const },
  { name: 'techdebt', score: 70, weight: 0.12, status: 'scored' as const },
  { name: 'refactor', score: 55, weight: 0.08, status: 'scored' as const },
  { name: 'backup', score: 95, weight: 0.06, status: 'scored' as const },
];

function cards(dims = FULL_DIMENSIONS, now = NOW) {
  return categoryScoreCards({ dimensions: dims, generatedAt: GENERATED_AT, now });
}

/** 十域全跑过时的总分入参（run=total ⇒ 不该出现覆盖范围提示） */
const OVERALL: OverallScoreInput = { score: 89.5, partial: { run: 10, total: 10 } };

function row(overall: OverallScoreInput = OVERALL): ReactElement {
  return <ScoreOverviewRow dimensions={FULL_DIMENSIONS} generatedAt={GENERATED_AT} overall={overall} />;
}

function renderWithNav(node: ReactElement, navigate = () => undefined): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <NavigationProvider navigate={navigate} currentPage="reports">
        {node}
      </NavigationProvider>
    </I18nProvider>,
  );
}

describe('分类评分卡 — 顺序与映射', () => {
  it('卡片顺序严格等于顶部导航顺序（inspect 开头、backup 结尾）', () => {
    expect(cards().map((c) => c.navId)).toEqual(navItems.map((i) => i.id));
    expect(cards()[0]!.navId).toBe('inspect');
    expect(cards().at(-1)!.navId).toBe('backup');
  });

  it('分类 ↔ 维度是双射：集合相等，且方向反查自洽', () => {
    const mapped = navItems.map((i) => i.scoreDimension).filter((d) => d !== null);
    // 无重复（两个分类抢同一维度会让同一分数出现两次、另一个维度消失）
    expect(new Set(mapped).size).toBe(mapped.length);
    // 覆盖全部十域（新增维度不加卡 = 分数看不见）
    expect([...mapped].sort()).toEqual([...HEALTH_SCORE_DIMENSIONS].sort());
    for (const item of navItems) {
      if (!item.scoreDimension) continue;
      expect(navIdForDimension(item.scoreDimension)).toBe(item.id);
    }
  });

  it('卡片标题用导航文案，与跳转目标同名（不是评分维度名）', () => {
    const byId = new Map(cards().map((c) => [c.navId, c]));
    expect(byId.get('inspect')!.title).toBe('项目体检');
    expect(byId.get('deps')!.title).toBe('依赖管家');
    expect(byId.get('techdebt')!.title).toBe('技术债务');
    // 「质量」是维度名，不该出现在卡片标题上（否则用户点「质量」跳到「项目体检」）
    expect(byId.get('inspect')!.title).not.toBe('质量');
    // 维度名退到 hover 提示里，作为口径说明
    expect(byId.get('inspect')!.hint).toContain('质量');
    expect(byId.get('inspect')!.hint).toContain('16%');
  });
});

describe('分类评分卡 — 分数口径', () => {
  it('已检测：显示真分与等级', () => {
    const security = cards().find((c) => c.navId === 'security')!;
    expect(security.view.kind).toBe('scored');
    expect(security.view.scoreText).toBe('88');
    expect(security.view.label).toBe('良好');
  });

  it('未检测：显示「—」+「未检测」，绝不当 0 分', () => {
    const sentinel = cards().find((c) => c.navId === 'sentinel')!;
    expect(sentinel.view.kind).toBe('not-run');
    expect(sentinel.view.scoreText).toBe('—');
    expect(sentinel.view.label).toBe('未检测');
    expect(sentinel.view.label).not.toBe('危险');
  });

  it('真 0 分（已检测）如实显示 0，不得被吞成未检测', () => {
    const gate = cards().find((c) => c.navId === 'guard')!;
    expect(gate.view.kind).toBe('scored');
    expect(gate.view.scoreText).toBe('0');
    expect(gate.view.label).toBe('危险');
  });

  it('汇总记录缺该维（老记录只有 5 维）：显示「—」+「暂无评分」', () => {
    const legacy = [
      { name: 'quality', score: 98, weight: 0.3 },
      { name: 'security', score: 98, weight: 0.3 },
    ];
    const row = cards(legacy);
    expect(row).toHaveLength(10);
    const refactor = row.find((c) => c.navId === 'refactor')!;
    expect(refactor.view.kind).toBe('no-data');
    expect(refactor.view.scoreText).toBe('—');
    expect(refactor.view.label).toBe('暂无评分');
  });

  it('超过 24h 判陈旧，并在 hover 提示里报出来', () => {
    const stale = cards(FULL_DIMENSIONS, new Date('2026-10-25T14:00:00.000Z').getTime());
    const quality = stale.find((c) => c.navId === 'inspect')!;
    expect(quality.view.kind).toBe('stale');
    expect(quality.hint).toContain('小时前的数据');
  });
});

describe('评分总览行 — 合并渲染', () => {
  it('一行十一格：首格总分（不可点），后接十张可点分类卡', () => {
    const html = renderWithNav(row());
    // 十张分类卡是 button
    expect(html.match(/<button/g) ?? []).toHaveLength(10);
    expect(html).toMatch(/grid-cols-11/);
    // 第一张分类卡之前只有总分卡，且它必须是普通卡片（div）——
    // 总分没有落点，做成 button 却无效果是假交互
    const overall = html.slice(0, html.indexOf('<button'));
    expect(overall).toContain('data-testid="overall-score-tile"');
    expect(overall).not.toContain('<button');
    expect(overall).toContain('总分');
    expect(overall).toContain('89.5');
  });

  it('总分卡排在第一格，分类卡顺序在 DOM 里仍等于导航顺序', () => {
    const html = renderWithNav(row());
    const targets = [...html.matchAll(/data-nav-target="([^"]+)"/g)].map((m) => m[1]);
    expect(targets).toEqual(navItems.map((i) => i.id));
    // 总分必须出现在第一张分类卡之前（否则「总分 + 十卡」的读法就断了）
    expect(html.indexOf('data-testid="overall-score-tile"')).toBeLessThan(
      html.indexOf('data-nav-target="inspect"'),
    );
  });

  it('每张分类卡只带名称/分数/等级三样，跳转目标是自己的分类 id', () => {
    const html = renderWithNav(row());
    const sentinel = html.slice(html.indexOf('data-nav-target="sentinel"'));
    const tile = sentinel.slice(0, sentinel.indexOf('</button>'));
    expect(tile).toContain('哨兵监控');
    expect(tile).toContain('未检测');
    expect(tile).toContain('data-dimension="sentinel"');
    // 有导航上下文时不得是禁用态
    expect(tile).not.toContain('disabled');
  });

  it('无 NavigationProvider 时分类卡降级禁用，不静默跳默认页', () => {
    const html = renderToStaticMarkup(<I18nProvider>{row()}</I18nProvider>);
    const firstTile = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(firstTile).toContain('disabled');
  });

  it('只跑了部分域时出现覆盖范围提示；跑全了则没有', () => {
    const partial = renderWithNav(
      row({ score: 92, partial: { run: 2, total: 10 } }),
    );
    expect(partial).toContain('data-testid="partial-notice"');
    expect(partial).toContain('仅由已检测的 2 / 10 个维度加权');
    expect(renderWithNav(row())).not.toContain('partial-notice');
  });

  it('红线封顶时提示原因为何被压制；未封顶则不出现', () => {
    const capped = renderWithNav(
      row({
        score: 60,
        partial: { run: 10, total: 10 },
        redLine: { capped: true, cap: 60, reasons: [{ kind: 'critical', count: 3 }] },
      }),
    );
    expect(capped).toContain('data-testid="redline-notice"');
    expect(capped).toContain('60');
    expect(renderWithNav(row())).not.toContain('redline-notice');
  });

  it('数据陈旧时走下方提示条报出，不把旧分当当前状态', () => {
    const stale = renderToStaticMarkup(
      <I18nProvider>
        <ScoreOverviewRow
          dimensions={FULL_DIMENSIONS}
          generatedAt="2026-10-20T11:02:00.000Z"
          overall={OVERALL}
        />
      </I18nProvider>,
    );
    expect(stale).toContain('data-testid="stale-notice"');
    expect(stale).toContain('小时前的数据');
  });

  it('卡片上方不得再挂趋势图 / 常驻数据时间 / 操作提示（精简后防回归）', () => {
    const html = renderWithNav(row());
    expect(html).not.toContain('数据时间');
    expect(html).not.toContain('点分类卡进入对应分类');
    expect(html).not.toContain('总分基于各域最近一次结果汇总');
    expect(html).not.toContain('<svg');
    // 标题本身保留：下方还有「模块评分」卡，没有标题两块会被当成同一批数据的两种排法
    expect(html).toContain('评分总览');
  });

  it('卡片行按导航分组分段：守护组排在行尾且与前一组留缝', () => {
    const html = renderWithNav(row());
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
    // 顺序仍等于导航顺序，分组只是标记
    expect(groups).toEqual(navItems.map((i) => i.group));
    expect(groups.filter((g) => g === 'daemon')).toEqual(['daemon', 'daemon']);
    // 组边界只有一处：守护组第一张（哨兵）带 starts-group，其余九张都不带
    const starts = [...html.matchAll(/data-starts-group="true"/g)];
    expect(starts).toHaveLength(1);
    const sentinelCard = html.slice(
      html.indexOf('data-nav-target="sentinel"'),
      html.indexOf('data-nav-target="backup"'),
    );
    expect(sentinelCard).toContain('data-starts-group="true"');
    const beforeSentinel = html.slice(0, html.indexOf('data-nav-target="sentinel"'));
    expect(beforeSentinel).not.toContain('data-starts-group');
  });

  it('点击只做页面切换：源码里只有 navigate(card.navId)，不触发任何扫描', () => {
    const src = readFileSync(new URL('../pages/category-score-cards.tsx', import.meta.url), 'utf-8');
    // 唯一跳转调用
    expect(src).toMatch(/onSelect\(card\.navId\)/);
    // 卡片不得自己发起检查（报告中心只读汇总，触发权归各域）
    expect(src).not.toMatch(/scan|generateReport|trigger/i);
  });
});
