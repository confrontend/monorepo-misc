import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A form-native switch adapter.  `role="switch"` communicates the on/off
 * semantics to assistive technology while retaining normal form submission.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, role: _role, ...props }, ref) => (
    <input {...props} ref={ref} type="checkbox" role="switch" className={cn(className)} />
  ),
);

Switch.displayName = 'Switch';
