import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={100}>
    {children}
  </TooltipPrimitive.Provider>
);

type TooltipProps = ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>;

// Keep the adapter safe for existing call sites that were not previously
// required to mount a provider at the application root.
export const Tooltip = ({ children, ...props }: TooltipProps) => (
  <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={100}>
    <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>
);
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = ({
  className,
  side = 'top',
  sideOffset = 6,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      {...props}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={8}
      // Tooltips are short, viewport-aware overlays.  Keep this invariant in
      // the shared adapter so an older/stale stylesheet cannot turn a tooltip
      // into a tiny scroll container with clipped facts.
      style={{
        ...props.style,
        maxHeight: 'none',
        overflow: 'visible',
        overflowX: 'visible',
        overflowY: 'visible',
      }}
      data-vantage-tooltip="true"
      className={cn('vantage-tooltip', className)}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
);
