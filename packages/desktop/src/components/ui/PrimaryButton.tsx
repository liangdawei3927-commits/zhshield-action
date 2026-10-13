import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { useT } from '../../i18n';
import { BaseButton, type ButtonVariant } from './BaseButton';

export interface PrimaryButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'className' | 'children'
> {
  children: ReactNode;
  className?: string;
  loading?: boolean;
  loadingLabel?: string;
}

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
    <BaseButton
      variant="primary"
      className={className}
      loading={loading}
      loadingLabel={loadingLabel}
      disabled={disabled}
      {...rest}
    >
      {loading ? (loadingLabel ?? t('common.loading')) : children}
    </BaseButton>
  );
}
