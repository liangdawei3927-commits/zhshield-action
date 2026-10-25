import type { ReactNode } from 'react';
import { Bounce } from '../ui/Bounce';
import { NavIcon } from '../ui/Icons';

export type GlyphTone = 'brand' | 'info' | 'success' | 'warning' | 'danger';

const WRAP: Record<GlyphTone, string> = {
  brand: 'bg-brand-50',
  info: 'bg-info-50',
  success: 'bg-success-50',
  warning: 'bg-warning-50',
  danger: 'bg-danger-50',
};
const STROKE: Record<GlyphTone, string> = {
  brand: 'rgb(var(--zh-brand))',
  info: 'rgb(var(--zh-info))',
  success: 'rgb(var(--zh-success))',
  warning: 'rgb(var(--zh-warning))',
  danger: 'rgb(var(--zh-danger))',
};

/** 页面顶部分类图标外壳：统一的圆角底色方块 + 描边图标 */
export function PageGlyph({ bg = 'brand', stroke = 'brand', round = false, children }: {
  bg?: GlyphTone; stroke?: GlyphTone; round?: boolean; children: ReactNode;
}) {
  return (
    <Bounce className={`w-14 h-14 rounded-xl ${WRAP[bg]} flex items-center justify-center`}>
      <svg
        width="32" height="32" viewBox="0 0 24 24" fill="none"
        stroke={STROKE[stroke]} strokeWidth="2"
        {...(round ? { strokeLinecap: 'round', strokeLinejoin: 'round' } : {})}
      >
        {children}
      </svg>
    </Bounce>
  );
}

/** 分类色板：底色与描边可不同（备份页沿用「绿底 + 品牌色描边」的旧观感） */
export interface NavGlyphTone {
  bg: GlyphTone;
  stroke: GlyphTone;
}

/**
 * 十个分类的图标色调表 —— 键必须与 `nav-items.ts` 的导航 id 一致。
 *
 * 色调只管颜色（语义色：安全=危险红、垃圾=成功绿…），**图形一律取自 NAV_ICON_CONTENT**，
 * 这样导航栏按钮与分类页标题是同一张图，不会「名字一样、图形两套」。
 * 由 `nav-glyph-parity.test.ts` 锁死：导航项 ↔ 图标 ↔ 色调 三处必须一一对应。
 */
export const NAV_GLYPH_TONES: Record<string, NavGlyphTone> = {
  inspect: { bg: 'warning', stroke: 'warning' },
  guard: { bg: 'brand', stroke: 'brand' },
  security: { bg: 'danger', stroke: 'danger' },
  deps: { bg: 'brand', stroke: 'brand' },
  garbage: { bg: 'success', stroke: 'success' },
  performance: { bg: 'warning', stroke: 'warning' },
  techdebt: { bg: 'brand', stroke: 'brand' },
  refactor: { bg: 'info', stroke: 'info' },
  sentinel: { bg: 'info', stroke: 'info' },
  backup: { bg: 'success', stroke: 'brand' },
};

const DEFAULT_NAV_GLYPH_TONE: NavGlyphTone = { bg: 'brand', stroke: 'brand' };

/**
 * 分类页顶行图标 —— 与顶部导航栏按钮**同一个图标**（`NavIcon`），套 PageGlyph 底板。
 *
 * 用法：`<NavGlyph navId="inspect" />`（navId 必须来自 nav-items.ts 的导航 id）。
 * 页面不要再内联 svg path：那正是「详情页图标与导航栏不一致」的根因。
 */
export function NavGlyph({ navId, size = 32 }: { navId: string; size?: number }) {
  const tone = NAV_GLYPH_TONES[navId] ?? DEFAULT_NAV_GLYPH_TONE;
  return (
    <Bounce className={`w-14 h-14 rounded-xl ${WRAP[tone.bg]} flex items-center justify-center`}>
      {/* NavIcon 用 currentColor 取色 → 由外层 span 的 color 决定描边色，避免嵌套 svg 丢色 */}
      <span className="flex items-center justify-center" style={{ color: STROKE[tone.stroke] }}>
        <NavIcon id={navId} size={size} strokeWidth={2} />
      </span>
    </Bounce>
  );
}
