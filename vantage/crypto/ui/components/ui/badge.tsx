import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

export const Badge = ({ className, ...props }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('status-pill', className)} {...props} />
);
