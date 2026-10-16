import type { ReactNode } from 'react';
import { Bounce } from '../ui/Bounce';

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
