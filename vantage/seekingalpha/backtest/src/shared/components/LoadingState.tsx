export function LoadingState({ label, detail, compact = false }: {
  label: string;
  detail?: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'loading-state loading-state-compact' : 'loading-state'} role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <div className="loading-copy">
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
      <div className="loading-progress" aria-hidden="true"><i /></div>
    </div>
  );
}
