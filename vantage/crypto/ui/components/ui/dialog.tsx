import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export const Dialog = DialogPrimitive.Root;

export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = ({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) => (
  <DialogPrimitive.Overlay className={cn('copytrade-modal-backdrop', className)}>
    {children}
  </DialogPrimitive.Overlay>
);

export const DialogContent = ({
  children,
  className,
  asChild = false,
}: {
  children: ReactNode;
  className?: string;
  asChild?: boolean;
}) => (
  <DialogPrimitive.Content asChild={asChild} className={cn('copytrade-modal', className)}>
    {children}
  </DialogPrimitive.Content>
);

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
