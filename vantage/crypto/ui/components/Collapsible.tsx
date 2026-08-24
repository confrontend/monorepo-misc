import type { ReactNode, SyntheticEvent } from 'react';

type CollapsibleProps = {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
};

export const Collapsible = ({ summary, children, className, open, onToggle }: CollapsibleProps) => (
  <details
    className={className}
    open={open}
    onToggle={onToggle ? (event: SyntheticEvent<HTMLDetailsElement>) => onToggle(event.currentTarget.open) : undefined}
  >
    <summary>{summary}</summary>
    {children}
  </details>
);
