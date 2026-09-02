import type { ReactNode } from 'react';

type StatusPillProps = {
  status: string;
  children?: ReactNode;
};

const statusLabel = (status: string): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

const statusTone = (status: string): 'positive' | 'warning' | 'negative' | 'neutral' => {
  if (status === 'eligible' || status === 'pass' || status === 'profitable' || status === 'WINNER')
    return 'positive';
  if (status === 'rejected' || status === 'fail' || status === 'REJECTED') return 'negative';
  if (status === 'UNPROVEN') return 'warning';
  if (status.includes('insufficient') || status.includes('missing')) return 'warning';
  return 'neutral';
};

export function StatusPill({ status, children }: StatusPillProps) {
  return (
    <span className={`status-pill ${statusTone(status)}`}>{children ?? statusLabel(status)}</span>
  );
}
