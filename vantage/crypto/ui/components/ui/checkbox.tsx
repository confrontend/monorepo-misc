import type { InputHTMLAttributes } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { cn } from '../../lib/utils.js';

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Sets the native indeterminate state for tri-state tables and filters. */
  indeterminate?: boolean;
};

/** Native checkbox adapter with explicit indeterminate support. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, ...props }, forwardedRef) => {
    const localRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(forwardedRef, () => localRef.current as HTMLInputElement);

    useEffect(() => {
      if (localRef.current) localRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return <input {...props} ref={localRef} type="checkbox" className={cn(className)} />;
  },
);

Checkbox.displayName = 'Checkbox';
