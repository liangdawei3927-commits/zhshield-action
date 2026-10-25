/**
 * 分类页标题图标 ↔ 顶部导航栏图标 一致性守卫（2026-10-25）。
 *
 * 背景（本次修的缺陷）：十个分类的详情页顶行图标是**各页面内联的一份 svg path**
 * ——体检页画放大镜、门禁页画「盾牌+闪电」、重构页画扳手、备份页画软盘——
 * 而顶部导航栏按钮用的是 `NAV_ICON_CONTENT`（体检=扫描文档、门禁=挂锁、
 * 重构=双向箭头、备份=回滚时钟）。同一个分类、同一个名字，两处图形不一样。
 *
 * 锁四件事（任一回潮都会红）：
 * 1) **图形存在**：每个导航项在 NAV_ICON_CONTENT 里有图标（否则页面标题变空白块）；
 * 2) **色调存在**：每个导航项在 NAV_GLYPH_TONES 里有配色（否则静默掉回 brand 默认色）；
 * 3) **页面不许再内联 PageGlyph**：十页的顶行图标一律走 NavGlyph；
 * 4) **图形同源（行为断言）**：NavGlyph 渲染出的 path 必须与导航栏 NavIcon 逐条一致，
 *    只断言「用了 NavGlyph」不够 —— 用别的图形照样能过结构断言。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { navItems } from '../components/layout/nav-items';
import { NavIcon, hasNavIcon } from '../components/ui/Icons';
import { NavGlyph, NAV_GLYPH_TONES } from '../components/business/page-glyph';

/** 导航分类 → 承载其顶行图标的页面文件（安全域的结果页在 security-report-parts） */
const PAGE_FILES: Record<string, string[]> = {
  inspect: ['InspectPage.tsx'],
  guard: ['GuardPage.tsx'],
  security: ['SecurityPage.tsx', 'security-report-parts.tsx'],
  deps: ['DependencyPage.tsx'],
  garbage: ['GarbagePage.tsx'],
  performance: ['PerformancePage.tsx'],
  techdebt: ['TechDebtPage.tsx'],
  refactor: ['RefactorPage.tsx'],
  sentinel: ['SentinelPage.tsx'],
  backup: ['BackupPage.tsx'],
};

function readPage(file: string): string {
  return readFileSync(new URL(`../pages/${file}`, import.meta.url), 'utf-8');
}

/**
 * 剥掉注释后再断言源码：否则「注释里写了正确的 navId、代码里是错的」也能绿
 * （反向自证时抓到过一次 —— 改了代码没改注释，断言命中注释行照样通过）。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 抽出 svg 里的几何数据（d / points / cx-cy-r / x-y-width-height…），只比图形不比尺寸颜色 */
function geometryOf(markup: string): string[] {
  return [...markup.matchAll(/(?:d|points)="([^"]+)"/g)].map((m) => m[1]!);
}

describe('导航项 ↔ 图标 ↔ 色调 一一对应', () => {
  it('10 个分类全部有图标（缺图标 = 页面标题渲染成空白方块）', () => {
    expect(navItems).toHaveLength(10);
    const missing = navItems.filter((item) => !hasNavIcon(item.id)).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it('10 个分类全部登记了页面图标色调（不靠默认值兜底）', () => {
    for (const item of navItems) {
      expect(NAV_GLYPH_TONES[item.id], `${item.id} 缺少色调`).toBeDefined();
    }
    // 色调表不许凭空多出导航项以外的键（改了导航却忘了清表，同样是漂移）
    const navIds = navItems.map((i) => i.id);
    expect(Object.keys(NAV_GLYPH_TONES).sort()).toEqual([...navIds].sort());
  });
});

describe('分类页顶行图标不再另写一份图形', () => {
  it('每个分类页都引用了本分类的 NavGlyph，且不再内联 PageGlyph', () => {
    for (const item of navItems) {
      const files = PAGE_FILES[item.id];
      expect(files, `${item.id} 未登记页面文件`).toBeDefined();
      for (const file of files!) {
        const src = stripComments(readPage(file));
        expect(src, `${file} 未使用 NavGlyph(${item.id})`).toContain(`navId="${item.id}"`);
        expect(src, `${file} 仍在内联 PageGlyph`).not.toContain('<PageGlyph');
      }
    }
  });
});

describe('渲染自证：页面图标与导航栏按钮同一张图', () => {
  it('NavGlyph 输出的图形与 NavIcon 逐条一致', () => {
    for (const item of navItems) {
      const navMarkup = renderToStaticMarkup(<NavIcon id={item.id} size={28} />);
      const pageMarkup = renderToStaticMarkup(<NavGlyph navId={item.id} />);
      expect(pageMarkup, `${item.id} 页面图标未渲染出图形`).toContain(`data-nav-icon="${item.id}"`);
      // 非零：两侧都是空也能「相等」，会变成假绿
      expect(geometryOf(navMarkup).length, `${item.id} 导航栏图标为空`).toBeGreaterThan(0);
      expect(geometryOf(pageMarkup), `${item.id} 页面图标与导航栏不一致`).toEqual(
        geometryOf(navMarkup),
      );
    }
  });
});
