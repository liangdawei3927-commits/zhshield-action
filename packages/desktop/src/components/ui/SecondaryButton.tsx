import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { BaseButton } from './BaseButton';

export interface SecondaryButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'className' | 'children'
> {
  children: ReactNode;
  className?: string;
}

export function SecondaryButton({ children, className, disabled, ...rest }: SecondaryButtonProps) {
  return (
    <BaseButton variant="secondary" className={className} disabled={disabled} {...rest}>
      {children}
    </BaseButton>
  );
}
