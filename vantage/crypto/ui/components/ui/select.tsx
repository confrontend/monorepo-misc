import type { SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

/**
 * Native select adapter.  Radix Select is deliberately not used here because
 * it changes native form serialization, empty-value handling, and keyboard
 * behavior relied on by the existing research controls.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => <select ref={ref} className={cn(className)} {...props} />,
);

Select.displayName = 'Select';
