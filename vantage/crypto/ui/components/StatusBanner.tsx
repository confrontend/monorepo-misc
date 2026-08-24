import type { ReactNode } from 'react';

type StatusBannerProps = {
  tone: 'warning' | 'muted';
  children: ReactNode;
  as?: 'p' | 'small';
  role?: 'alert' | 'status';
  title?: string;
};

export const StatusBanner = ({ tone, children, as = 'p', role, title }: StatusBannerProps) => {
  const Tag = as;
  return (
    <Tag className={tone === 'warning' ? 'copytrade-status-warning' : 'muted'} role={role} title={title}>
      {children}
    </Tag>
  );
};
