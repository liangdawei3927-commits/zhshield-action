import type { CSSProperties, ReactNode } from 'react';
import { ResultCard } from './ResultCard';

/**
 * 入口卡片（图标块 + 主行标题 + 副行文字）——所有页面「图标 + 标题 + 数值/描述」
 * 类卡片的统一实现。过去在体检页 DomainCardGrid（紧凑彩色状态卡）与 PageShell
 * FeatureList（中号中性功能卡）各写一份，样式已漂移；此处收敛为 size 双 preset。
 *
 * 视觉语义与 ResultCard 其他 variant 的区分：
 *  - EntryCard：横向图标块 + 两行文字，适合「域名入口 / 功能入口」；
 *  - 纵向「小标签 + 大数字」读数卡（如门禁 GuardStats）是另一类语义，不走本组件。
 */
export interface EntryCardProps {
  /** 左侧图标块内容（SVG/图标） */
  icon: ReactNode;
  /** 主行标题 */
  title: string;
  /** 副行文字（数值/描述），缺省不渲染 */
  sub?: string;
  /** 图标块内联样式（主题色/背景色），如 { color, background } */
  iconStyle?: CSSProperties;
  /** 副行文字内联颜色（状态着色，如过期 warning），缺省用 preset 默认色 */
  subColor?: string;
  /** 卡片提示（原生 title 属性） */
  tooltip?: string;
  /** 尺寸 preset：sm=体检页紧凑状态卡，md=空态页中号功能卡 */
  size?: 'sm' | 'md';
  /** 渲染元素（默认 div；传 "button" 让整卡可点击下钻） */
  as?: 'div' | 'button';
  /** 点击回调（配合 as="button"） */
  onClick?: () => void;
  /** 追加 className（透传给 ResultCard） */
  className?: string;
}

const SIZE: Record<
  NonNullable<EntryCardProps['size']>,
  {
    cardVariant: 'item' | 'stats';
    iconBox: string;
    title: string;
    sub: string;
  }
> = {
  /** 体检页六域入口：紧凑、图标彩色底、副行加粗数值（w-10/text-sm 与 md 视觉重量对齐，消除与其他页面卡片的高度差） */
  sm: {
    cardVariant: 'stats',
    iconBox: 'shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-transform group-hover:scale-105',
    title: 'text-sm font-medium text-zh-ink truncate',
    sub: 'text-base font-bold leading-none mt-1',
  },
  /** 空态页功能引导：中号图标块、标题 + 描述（图标块品牌浅色底，与白卡分层） */
  md: {
    cardVariant: 'item',
    iconBox: 'shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-brand-700 bg-brand-50 shadow-sm',
    title: 'text-sm font-semibold text-zh-ink leading-tight',
    sub: 'text-[11px] text-zh-muted mt-0.5 leading-relaxed',
  },
};

/** 入口卡片：图标块 + 主行 + 副行（ResultCard 之上的内容层，size=sm/md 双 preset） */
export function EntryCard({
  icon,
  title,
  sub,
  iconStyle,
  subColor,
  tooltip,
  size = 'md',
  as,
  onClick,
  className,
}: EntryCardProps) {
  const preset = SIZE[size];
  return (
    <ResultCard
      variant={preset.cardVariant}
      as={as}
      onClick={onClick}
      title={tooltip}
      className={`flex items-center gap-3 ${size === 'sm' ? 'w-full text-left transition-all group cursor-pointer' : ''}${className ? ` ${className}` : ''}`}
    >
      <span className={preset.iconBox} style={iconStyle}>
        {icon}
      </span>
      <span className="min-w-0 flex flex-col">
        <span className={preset.title}>{title}</span>
        {sub !== undefined && (
          <span className={preset.sub} style={subColor ? { color: subColor } : undefined}>
            {sub}
          </span>
        )}
      </span>
    </ResultCard>
  );
}