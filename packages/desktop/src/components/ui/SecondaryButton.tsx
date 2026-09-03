import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Bounce } from './Bounce';

interface SecondaryButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'className' | 'children'
> {
  children: ReactNode;
  /** 追加类名（如 ml-auto 布局调整） */
  className?: string;
}

/**
 * 全局统一副操作按钮：分类页模板中的「副操作描边按钮」
 * （品牌盾青描边 + 透明底，180 x 48 圆角胶囊，与 PrimaryButton 等高对齐）
 *
 * 用于承载「查看报告」「高级设置」等次级动作，
 * 避免与主操作争夺视觉焦点（设计规范 §统一分类页模板）。
 */
export function SecondaryButton({ children, className, disabled, ...rest }: SecondaryButtonProps) {
  return (
    <Bounce
      as="button"
      disabled={disabled}
      className={`
        w-[180px] h-12 rounded-full font-semibold text-sm
        bg-transparent border-[1.5px] border-brand-600 text-brand-700
        hover:bg-brand-50 active:scale-[0.97] transition-all duration-200
        cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
        ${className ?? ''}
      `}
      {...rest}
    >
      {children}
    </Bounce>
  );
}
