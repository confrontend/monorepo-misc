import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

/**
 * Shared button adapter. The variant names intentionally map to Vantage's
 * existing CSS classes so adopting the shadcn-style API does not redesign the
 * application or change existing button semantics.
 */
const buttonVariants = cva('vantage-button', {
  variants: {
    variant: {
      primary: 'primary',
      secondary: 'secondary',
      destructive: 'secondary destructive',
      ghost: 'ghost',
      icon: 'icon',
    },
    size: {
      default: '',
      sm: 'button-sm',
      lg: 'button-lg',
    },
  },
  defaultVariants: { variant: 'secondary', size: 'default' },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading = false, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="loading-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  ),
);

Button.displayName = 'Button';
