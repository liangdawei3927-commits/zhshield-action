import { BaseButton, type ButtonBaseProps } from './BaseButton';

export type SecondaryButtonProps = ButtonBaseProps;

export function SecondaryButton({ children, className, disabled, ...rest }: SecondaryButtonProps) {
  return (
    <BaseButton variant="secondary" className={className} disabled={disabled} {...rest}>
      {children}
    </BaseButton>
  );
}
