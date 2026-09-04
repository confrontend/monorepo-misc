import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * Vantage's shared text input adapter.  This intentionally remains a native
 * input: browser validation, autofill, numeric controls, and form libraries
 * all continue to work exactly as they do at existing call sites.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(className)} {...props} />,
);

Input.displayName = 'Input';
