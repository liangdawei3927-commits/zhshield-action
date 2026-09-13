import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Bounce } from './Bounce';
import { useT } from '../../i18n';

interface PrimaryButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'className' | 'children'
> {
  children: ReactNode;
  /** 追加类名（如 ml-auto 布局调整） */
  className?: string;
  /** 加载态：显示 spinner + loadingLabel，并禁用点击 */
  loading?: boolean;
  loadingLabel?: string;
}

/**
 * 全局统一主操作按钮：所有页面中间按钮的唯一大小与配色
 * （品牌盾青渐变，220 x 56 圆角胶囊，白字加粗，放大档与全站 PageShell 骨架统一）
 */
export function PrimaryButton({
  children,
  className,
  loading = false,
  loadingLabel,
  disabled,
  ...rest
}: PrimaryButtonProps) {
  const t = useT();
  return (
    <Bounce
      as="button"
      disabled={disabled || loading}
      className={`
        w-[220px] h-14 rounded-full text-white font-semibold text-base
        bg-gradient-to-r from-brand-600 to-brand-800
        shadow-lg shadow-black/10 hover:shadow-xl hover:shadow-black/15
        active:scale-[0.97] transition-all duration-200
        border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
        ${className ?? ''}
      `}
      {...rest}
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          {loadingLabel ?? t('common.loading')}
        </span>
      ) : (
        children
      )}
    </Bounce>
  );
}
