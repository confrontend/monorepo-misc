import { Modal } from './Modal.js';

export type PatternDiscoveryRule = {
  source?: string;
  kind?: string;
  feature?: string;
  conditions?: unknown;
  effect?: number | null;
  p_value?: number | null;
  q_value?: number | null;
  discovery_independence_groups?: number;
  discovery_wallets?: number;
  weighting?: string;
  promoted?: boolean;
  discovery_sample_size?: number;
  validationStatus?: string;
  historical_stability?: {
    status?: string;
    blocks?: number;
    surviving_blocks?: number;
  };
  validation?: {
    sample_size?: number;
    effect_vs_all?: number | null;
    coefficient?: number | null;
    independence_groups?: number;
    wallets?: number;
    weighting?: string;
    reason?: string;
  };
  reason?: string;
};

const FEATURE_LABELS: Record<string, string> = {
  prior_wallet_trade_count: 'Previous wallet trades',
  prior_token_trade_count: 'Previous trades for this token',
  prior_wallet_buy_volume_usd: 'Previous wallet buy volume',
};

export const labelFor = (feature?: string): string =>
  FEATURE_LABELS[feature ?? ''] ?? feature?.replaceAll('_', ' ') ?? 'Unknown feature';

const formatNumber = (value: number): string => {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
};

export const conditionText = (conditions: unknown): string => {
  if (!Array.isArray(conditions) || conditions.length === 0) return 'No simple rule was reported.';
  const parts = conditions
    .map((condition) => {
      if (!condition || typeof condition !== 'object') return null;
      const item = condition as {
        lower?: number;
        upper?: number;
        operator?: string;
        value?: number | string;
      };
      if (typeof item.lower === 'number' && typeof item.upper === 'number')
        return `${formatNumber(item.lower)}–${formatNumber(item.upper)}`;
      if (item.operator === '>=') return `${formatNumber(Number(item.value))}+`;
      if (item.operator === '<=') return `≤ ${formatNumber(Number(item.value))}`;
      if (item.operator === 'correlation' && item.value === 'negative')
        return 'higher values tend to have lower outcomes';
      if (item.operator === 'correlation' && item.value === 'positive')
        return 'higher values tend to have higher outcomes';
      if (item.operator && item.value !== undefined) return `${item.operator} ${item.value}`;
      return null;
    })
    .filter((part): part is string => Boolean(part));
  return parts.join(' and ') || 'No simple rule was reported.';
};

const correlationValue = (rule: PatternDiscoveryRule): number | null => {
  const validation = rule.validation?.coefficient;
  if (typeof validation === 'number') return validation;
  return typeof rule.effect === 'number' ? rule.effect : null;
};

const outcomeExplanation = (rule: PatternDiscoveryRule): string => {
  const effect = rule.effect;
  if (rule.kind === 'correlation') {
    return effect === null || effect === undefined
      ? 'The report did not provide a correlation value.'
      : `In the discovery sample, this relationship was ${effect >= 0 ? 'positive' : 'negative'}: higher ${labelFor(rule.feature).toLowerCase()} tended to align with ${effect >= 0 ? 'higher' : 'lower'} net copied returns. This is an association, not proof that the feature causes the outcome.`;
  }
  return effect === null || effect === undefined
    ? 'The report did not provide an outcome difference.'
    : `Events in this range differed from the overall discovery sample by ${effect >= 0 ? '+' : ''}${formatNumber(effect)} percentage points of net copied return. The value is an average comparison, not a promise for every trade.`;
};

const CorrelationVisual = ({ rule }: { rule: PatternDiscoveryRule }) => {
  const value = correlationValue(rule);
  const bounded = value === null ? 0 : Math.max(-1, Math.min(1, value));
  const x = 160 + bounded * 130;
  return (
    <div className="pattern-rule-visual" aria-label="Correlation direction and strength">
      <div className="pattern-rule-visual-heading">
        <strong>Relationship summary</strong>
        <span>{value === null ? 'Not available' : value.toFixed(2)}</span>
      </div>
      <svg
        className="pattern-correlation-plot"
        viewBox="0 0 320 72"
        role="img"
        aria-label={value === null ? 'Correlation unavailable' : `Correlation ${value.toFixed(2)}`}
      >
        <line x1="30" y1="36" x2="290" y2="36" className="pattern-plot-axis" />
        <line x1="160" y1="14" x2="160" y2="58" className="pattern-plot-zero" />
        {value !== null && (
          <>
            <line
              x1="160"
              y1="36"
              x2={x}
              y2="36"
              className={value >= 0 ? 'pattern-plot-positive' : 'pattern-plot-negative'}
            />
            <circle
              cx={x}
              cy="36"
              r="7"
              className={value >= 0 ? 'pattern-plot-positive-fill' : 'pattern-plot-negative-fill'}
            />
          </>
        )}
        <text x="24" y="68">
          lower outcome
        </text>
        <text x="137" y="11">
          0
        </text>
        <text x="232" y="68">
          higher outcome
        </text>
      </svg>
      <p className="muted">
        The marker shows direction and strength from the saved report. It is not a plot of
        individual trades.
      </p>
    </div>
  );
};

const EffectVisual = ({ rule }: { rule: PatternDiscoveryRule }) => {
  const effect = typeof rule.effect === 'number' ? rule.effect : null;
  const validationEffect =
    typeof rule.validation?.effect_vs_all === 'number' ? rule.validation.effect_vs_all : null;
  const max = Math.max(1, Math.abs(effect ?? 0), Math.abs(validationEffect ?? 0));
  const width = (value: number | null): number =>
    value === null ? 0 : Math.min(100, (Math.abs(value) / max) * 100);
  return (
    <div className="pattern-rule-visual" aria-label="Discovery and validation outcome difference">
      <div className="pattern-rule-visual-heading">
        <strong>Outcome difference</strong>
        <span>percentage points</span>
      </div>
      <div className="pattern-effect-row">
        <span>Discovery</span>
        <div className="pattern-effect-track">
          <i
            className={(effect ?? 0) >= 0 ? 'positive' : 'negative'}
            style={{ width: `${width(effect)}%` }}
          />
        </div>
        <b>{effect === null ? '—' : `${effect >= 0 ? '+' : ''}${formatNumber(effect)}`}</b>
      </div>
      <div className="pattern-effect-row">
        <span>Validation</span>
        <div className="pattern-effect-track">
          <i
            className={(validationEffect ?? 0) >= 0 ? 'positive' : 'negative'}
            style={{ width: `${width(validationEffect)}%` }}
          />
        </div>
        <b>
          {validationEffect === null
            ? '—'
            : `${validationEffect >= 0 ? '+' : ''}${formatNumber(validationEffect)}`}
        </b>
      </div>
      <p className="muted">
        Positive means the selected range did better than the comparison population; negative means
        worse.
      </p>
    </div>
  );
};

export const PatternDiscoveryRuleDialog = ({
  rule,
  onClose,
}: {
  rule: PatternDiscoveryRule;
  onClose: () => void;
}) => {
  const repeated = rule.validationStatus === 'validation survivor';
  const isCorrelation = rule.kind === 'correlation';
  return (
    <Modal
      onClose={onClose}
      ariaLabel={`Pattern details for ${labelFor(rule.feature)}`}
      dialogClassName="pattern-discovery-rule-modal"
    >
      <div className="pattern-rule-dialog-heading">
        <div>
          <span className="eyebrow">DISCOVERY RULE</span>
          <h2>{labelFor(rule.feature)}</h2>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        {isCorrelation
          ? 'A relationship measured across the selected historical events.'
          : 'A range of historical values whose copied outcomes differed from the comparison population.'}
      </p>
      <div
        className={`pattern-rule-summary ${rule.effect !== null && rule.effect !== undefined && rule.effect >= 0 ? 'positive-rule' : 'negative-rule'}`}
      >
        <small>PLAIN-LANGUAGE RULE</small>
        <strong>{conditionText(rule.conditions)}</strong>
        <p>{outcomeExplanation(rule)}</p>
      </div>
      {isCorrelation ? <CorrelationVisual rule={rule} /> : <EffectVisual rule={rule} />}
      <div className="pattern-rule-example">
        <strong>Example</strong>
        <p>
          {isCorrelation
            ? `Before a trade, compare its ${labelFor(rule.feature).toLowerCase()} with the direction shown above. A higher value is associated with ${rule.effect !== null && rule.effect !== undefined && rule.effect >= 0 ? 'better' : 'worse'} copied outcomes in this sample.`
            : `If a new event's ${labelFor(rule.feature).toLowerCase()} falls between ${conditionText(rule.conditions)}, it belongs to this rule's range. Use the effect as historical context, not as a guaranteed return.`}
        </p>
      </div>
      <div className="pattern-rule-dialog-meta">
        <span>
          Discovery events <b>{rule.discovery_sample_size ?? 0}</b>
        </span>
        <span>
          Validation events <b>{rule.validation?.sample_size ?? 0}</b>
        </span>
        <span>
          Status <b>{repeated ? 'Repeated' : 'Candidate'}</b>
        </span>
        {rule.source && (
          <span>
            Method <b>{rule.source}</b>
          </span>
        )}
      </div>
      {rule.reason && (
        <p className="pattern-rule-reason">
          <strong>Engine note:</strong> {rule.reason}
        </p>
      )}
    </Modal>
  );
};
