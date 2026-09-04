import type { TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils.js';

/** Native textarea adapter preserving controlled and uncontrolled semantics. */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => <textarea ref={ref} className={cn(className)} {...props} />);

Textarea.displayName = 'Textarea';
