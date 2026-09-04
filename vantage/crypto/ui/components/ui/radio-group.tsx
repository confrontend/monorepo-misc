import type { InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

type RadioGroupProps = {
  children: ReactNode;
  className?: string;
  name?: string;
  'aria-label'?: string;
};

/** Lightweight grouping adapter for native radios; browser keyboard behavior is preserved. */
export const RadioGroup = ({ children, className, ...props }: RadioGroupProps) => (
  <div role="radiogroup" className={cn(className)} {...props}>
    {children}
  </div>
);

type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const Radio = forwardRef<HTMLInputElement, RadioProps>(({ className, ...props }, ref) => (
  <input {...props} ref={ref} type="radio" className={cn(className)} />
));

Radio.displayName = 'Radio';
