import React from 'react';
import { Loader2 } from 'lucide-react';
import { buttonClasses, labelChildren, type ButtonSize, type ButtonVariant } from './ds/Button';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  icon?: React.ReactNode;
}

/**
 * The older app-wide button (dashboard, settings, admin, the classic editor). Same props and variants as
 * before; it paints with the Atlas Button recipes (components/ds/Button.tsx `buttonClasses`): primary is the
 * ink fill, secondary the soft well, outline the hairline edge, danger the solid danger fill. 44 px under a
 * coarse pointer, the ink focus outline, press feedback (motion-safe). A caller's className still wins.
 */
const VARIANT: Record<NonNullable<ButtonProps['variant']>, ButtonVariant> = {
  primary: 'default',
  secondary: 'secondary',
  outline: 'outline',
  danger: 'destructive'
};

const SIZE: Record<NonNullable<ButtonProps['size']>, ButtonSize> = {
  sm: 'sm',
  md: 'default',
  lg: 'lg'
};

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  isLoading,
  icon,
  className = '',
  disabled,
  type,
  ...props
}) => {
  return (
    <button
      type={type}
      className={buttonClasses({ variant: VARIANT[variant], size: SIZE[size], className: `relative flex ${className}` })}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : icon ? (
        <span className="inline-flex shrink-0 items-center">{icon}</span>
      ) : null}
      {labelChildren(children)}
    </button>
  );
};
