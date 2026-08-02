// Colored-dot badge matching the mockup's badgeFor()/candidateBadge() style.
// `kind` selects the color via the .status-badge.<kind> rules in index.css;
// `label` defaults to `kind` itself (decision/resolved-status names already
// read fine as labels: "Confirm", "Mixed", "Reject", "Wait", "Open", "Resolved").
export type BadgeKind = "Confirm" | "Mixed" | "Reject" | "Wait" | "Open" | "Resolved" | "neutral";

export default function Badge({ kind, label }: { kind: BadgeKind; label?: string }) {
  return (
    <span className={`status-badge ${kind}`}>
      <span className="dot" />
      {label ?? kind}
    </span>
  );
}
