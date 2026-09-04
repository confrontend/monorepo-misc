import type { MouseEvent, ReactNode } from 'react';
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from './ui/dialog.js';

type ModalProps = {
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  backdropClassName?: string;
  dialogClassName?: string;
  dialogAs?: 'div' | 'article';
};

export const Modal = ({
  onClose,
  ariaLabel,
  children,
  backdropClassName,
  dialogClassName,
  dialogAs = 'div',
}: ModalProps) => {
  const DialogElement = dialogAs === 'article' ? 'article' : 'div';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className={backdropClassName}>
          <DialogContent className={dialogClassName} asChild={dialogAs !== 'div'}>
            <DialogElement onClick={(event: MouseEvent) => event.stopPropagation()}>
              <DialogTitle className="visually-hidden">{ariaLabel}</DialogTitle>
              {children}
            </DialogElement>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  );
};
