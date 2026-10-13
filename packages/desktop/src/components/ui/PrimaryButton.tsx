import { useT } from '../../i18n';
import { BaseButton, type ButtonBaseProps } from './BaseButton';

export interface PrimaryButtonProps extends ButtonBaseProps {
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
