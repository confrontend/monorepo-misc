import type { MouseEvent, ReactNode } from 'react';

type ModalProps = {
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  backdropClassName?: string;
  dialogClassName?: string;
  dialogAs?: 'div' | 'article';
};

export const Modal = ({ onClose, ariaLabel, children, backdropClassName, dialogClassName, dialogAs = 'div' }: ModalProps) => {
  const Dialog = dialogAs;
  return (
    <div className={`copytrade-modal-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`} role="presentation" onClick={onClose}>
      <Dialog
        className={`copytrade-modal${dialogClassName ? ` ${dialogClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        {children}
      </Dialog>
    </div>
  );
};
