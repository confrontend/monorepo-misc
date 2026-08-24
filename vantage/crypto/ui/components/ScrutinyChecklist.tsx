export type ScrutinyVerdict = 'pass' | 'fail' | 'insufficient';
export type ScrutinyCheck<M> = {
  key: string;
  label: string;
  verdict: ScrutinyVerdict;
  n: number;
  detail: string;
  metrics: M;
};

export const SCRUTINY_VERDICT_LABELS: Record<ScrutinyVerdict, string> = {
  pass: 'Pass',
  fail: 'Fail',
  insufficient: 'Insufficient data',
};
/** Shape + color together, not color alone, so the compact table cells stay readable for a
 *  colorblind reader without needing the text label spelled out in every row. */
export const SCRUTINY_VERDICT_ICONS: Record<ScrutinyVerdict, string> = {
  pass: '✓',
  fail: '✕',
  insufficient: '–',
};

const formatCount = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString();

/** Renders the per-wallet scrutiny checks (dormancy, coverage, coverage bias, etc.) computed by
 *  computeCandidateScrutiny (see src/copytrade/scrutiny/candidateScrutiny.ts) via GET
 *  /api/copytrade/scrutiny. This is the one place that renders them -- every caller (the Scrutiny
 *  tab's own detail dialog, the Wallet Stats "GMGN saved response" dialog) passes in whatever
 *  CandidateScrutinyReport['checks'] it already has, rather than re-implementing this grid. */
export function ScrutinyChecklist({ checks }: { checks: Record<string, ScrutinyCheck<unknown>> }) {
  return (
    <div className="scrutiny-check-grid">
      {Object.values(checks).map((check) => (
        <div className={`scrutiny-check scrutiny-check-${check.verdict}`} key={check.key}>
          <div className="scrutiny-check-header">
            <strong>{check.label}</strong>
            <span className={`scrutiny-verdict-badge scrutiny-verdict-${check.verdict}`}>
              {SCRUTINY_VERDICT_LABELS[check.verdict]}
            </span>
          </div>
          <p className="scrutiny-check-detail">{check.detail}</p>
          <small className="scrutiny-check-n">n = {formatCount(check.n)}</small>
        </div>
      ))}
    </div>
  );
}
