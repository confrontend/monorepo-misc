import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils.js';

/** Generic visual primitives. Domain cards should continue to own their layout. */
export const Card = ({ className, ...props }: HTMLAttributes<HTMLElement>) => (
  <article className={cn('vantage-card', className)} {...props} />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('vantage-card-header', className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('vantage-card-content', className)} {...props} />
);

export const CardFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('vantage-card-footer', className)} {...props} />
);
