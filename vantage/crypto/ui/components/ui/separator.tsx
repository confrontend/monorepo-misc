import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export type SeparatorProps = HTMLAttributes<HTMLHRElement> & {
  orientation?: 'horizontal' | 'vertical';
};

/** Presentation-only separator with an accessible separator role. */
export const Separator = ({ className, orientation = 'horizontal', ...props }: SeparatorProps) => (
  <hr
    role="separator"
    aria-orientation={orientation}
    className={cn(
      'vantage-separator',
      orientation === 'vertical' && 'vantage-separator-vertical',
      className,
    )}
    {...props}
  />
);
