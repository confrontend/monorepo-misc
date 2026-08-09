export type LegendItem = {
  term: string;
  meaning: string;
};

export function LegendPanel({ title = 'How to read this', items }: {
  title?: string;
  items: LegendItem[];
}) {
  return (
    <details className="legend-panel">
      <summary>{title}</summary>
      <div className="legend-grid">
        {items.map((item) => (
          <div className="legend-item" key={item.term}>
            <strong>{item.term}</strong>
            <span>{item.meaning}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
