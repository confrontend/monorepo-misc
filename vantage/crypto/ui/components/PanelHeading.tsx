import type { ReactNode } from 'react';

type PanelHeadingProps = {
  eyebrow: ReactNode;
  title: ReactNode;
  tag?: ReactNode;
};

export const PanelHeading = ({ eyebrow, title, tag }: PanelHeadingProps) => (
  <div className="panel-heading">
    <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
    {tag !== undefined && <span className="tag">{tag}</span>}
  </div>
);
