import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

/** Neutral loading placeholder for shared screens; layout remains caller-owned. */
export const Skeleton = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div aria-hidden="true" className={cn('vantage-skeleton', className)} {...props} />
);
