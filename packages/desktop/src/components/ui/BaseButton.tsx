import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Bounce } from './Bounce';

export type ButtonVariant = 'primary' | 'secondary';

export interface ButtonBaseProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'className' | 'children'
> {
  children: ReactNode;
  className?: string;
}

export interface BaseButtonProps extends ButtonBaseProps {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
}

export function BaseButton({
  children,
  className,
  variant = 'primary',
  loading = false,
  loadingLabel,
  disabled,
  ...rest
}: BaseButtonProps) {
  const isDisabled = disabled || loading;
  const baseClass =
    variant === 'primary'
      ? `
        w-[220px] h-14 rounded-full text-white font-semibold text-base
        bg-gradient-to-r from-brand-600 to-brand-800
        shadow-lg shadow-black/10 hover:shadow-xl hover:shadow-black/15
        active:scale-[0.97] transition-all duration-200
        border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
      `
      : `
        w-[220px] h-14 rounded-full font-semibold text-base
        bg-transparent border-[1.5px] border-brand-600 text-brand-700
        hover:bg-brand-50 active:scale-[0.97] transition-all duration-200
        cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
      `;
  return (
    <Bounce as="button" disabled={isDisabled} className={`${baseClass} ${className ?? ''}`} {...rest}>
      {children}
    </Bounce>
  );
}
