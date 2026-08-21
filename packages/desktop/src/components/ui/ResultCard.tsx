import type { ComponentPropsWithoutRef } from 'react';
import { BounceCard } from './Bounce';

export type ResultCardVariant = 'item' | 'score' | 'stats' | 'section' | 'list';

/** 各变体唯一的内边距，保证所有检查页卡片宽度/密度一致 */
const VARIANT_PADDING: Record<ResultCardVariant, string> = {
  /** 单条问题卡片（漏洞/性能/事件/垃圾条目） */
  item: 'px-5 py-4',
  /** 总分/进度/概览卡片 */
  score: 'p-5',
  /** 统计数字/关卡卡片 */
  stats: 'p-4',
  /** 大区块卡片（历史记录等） */
  section: 'p-6',
  /** 列表容器（内部自行排版，无内边距） */
  list: '',
};

interface ResultCardProps extends ComponentPropsWithoutRef<'div'> {
  /** 卡片变体，决定内边距（宽度/底色统一为 rounded-xl bg-zh-card shadow-sm） */
  variant?: ResultCardVariant;
}

/**
 * 全局统一的检查结果卡片：所有检查结果页卡片的唯一样式入口
 * （圆角 + 白底 + 阴影 + 品牌绿边框）。改这一处，巡检/门禁/安全/性能/哨兵/
 * 重构/垃圾/演进/报告/备份 全部生效。
 */
export function ResultCard({ variant = 'item', className, ...rest }: ResultCardProps) {
  return (
    <BounceCard
      className={`rounded-xl bg-zh-card shadow-sm ${VARIANT_PADDING[variant]}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  );
}
