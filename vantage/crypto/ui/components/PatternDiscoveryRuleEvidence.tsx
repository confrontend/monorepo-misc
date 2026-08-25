import { useMemo, useState } from 'react';
import { weightCategoryForFeature } from '../../src/copytrade/decisionCategories.js';
import { DataTable } from './DataTable.js';
import {
  conditionText,
  labelFor,
  type PatternDiscoveryRule,
} from './PatternDiscoveryRuleDialog.js';
import { UI_STRINGS } from '../strings.js';

type SortKey = 'category' | 'feature' | 'discoveryEffect' | 'validationEffect' | 'status';
type RuleFilter =
  'winners' | 'all' | 'Edge' | 'Consistency' | 'Robustness' | 'Copyability' | 'Unknown';

const CATEGORY_LABELS = {
  edge: 'Edge',
  consistency: 'Consistency',
  robustness: 'Robustness',
  copyability: 'Copyability',
} as const;

const formatNumber = (value: number | undefined | null): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';

const formatEffect = (value: number | undefined | null, kind?: string): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}${kind === 'correlation' ? '' : ' pts'}`
    : '—';

const formatPValue = (value: number | undefined | null): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toPrecision(3) : '—';

const categoryFor = (rule: PatternDiscoveryRule): string => {
  const category = rule.feature ? weightCategoryForFeature(rule.feature) : null;
  return category ? CATEGORY_LABELS[category] : 'Unknown';
};

const statusLabel = (rule: PatternDiscoveryRule): string =>
  rule.validationStatus === 'validation survivor' ? 'Validated' : 'Did not validate';

const validationEffectFor = (rule: PatternDiscoveryRule): number | null => {
  const value = rule.validation?.effect_vs_all ?? rule.validation?.coefficient;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const discoveryEffectFor = (rule: PatternDiscoveryRule): number | null =>
  typeof rule.effect === 'number' && Number.isFinite(rule.effect) ? rule.effect : null;

// A winner is directional evidence that is positive in both samples. For older reports where
// validation did not persist an effect, an explicitly surviving validation rule is the narrowest
// safe fallback; it is not presented as a success rate.
const isWinnerRule = (rule: PatternDiscoveryRule): boolean => {
  const discovery = discoveryEffectFor(rule);
  const validation = validationEffectFor(rule);
  if (discovery === null || discovery <= 0) return false;
  if (validation !== null) return validation > 0;
  return rule.validationStatus === 'validation survivor';
};

const evidenceToneFor = (
  rule: PatternDiscoveryRule,
): 'winner' | 'negative' | 'mixed' | undefined => {
  const discovery = discoveryEffectFor(rule);
  const validation = validationEffectFor(rule);
  if (isWinnerRule(rule)) return 'winner';
  if (discovery !== null && validation !== null && discovery < 0 && validation < 0)
    return 'negative';
  if (discovery !== null || validation !== null) return 'mixed';
  return undefined;
};

const historicalLabel = (rule: PatternDiscoveryRule): string => {
  const stability = rule.historical_stability;
  if (!stability) return '—';
  if (typeof stability.blocks === 'number' || typeof stability.surviving_blocks === 'number') {
    return `${formatNumber(stability.surviving_blocks)} / ${formatNumber(stability.blocks)}`;
  }
  return stability.status === 'stable' ? 'Stable' : (stability.status ?? '—');
};

export const PatternDiscoveryRuleEvidence = ({
  rules,
  onSelectRule,
}: {
  rules: PatternDiscoveryRule[];
  onSelectRule: (rule: PatternDiscoveryRule) => void;
}) => {
  const copy = UI_STRINGS.patternDiscovery;
  const [filter, setFilter] = useState<RuleFilter>('winners');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('validationEffect');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const compact = filter === 'winners';

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = rules.filter((rule) => {
      const category = categoryFor(rule);
      const matchesFilter =
        filter === 'winners' ? isWinnerRule(rule) : filter === 'all' || category === filter;
      const matchesSearch =
        !query ||
        `${labelFor(rule.feature)} ${conditionText(rule.conditions)} ${statusLabel(rule)}`
          .toLowerCase()
          .includes(query);
      return matchesFilter && matchesSearch;
    });
    return visible.sort((left, right) => {
      const value = (rule: PatternDiscoveryRule): string | number => {
        if (sortKey === 'category') return categoryFor(rule);
        if (sortKey === 'feature') return labelFor(rule.feature);
        if (sortKey === 'discoveryEffect') return rule.effect ?? Number.NEGATIVE_INFINITY;
        if (sortKey === 'validationEffect')
          return validationEffectFor(rule) ?? Number.NEGATIVE_INFINITY;
        return statusLabel(rule);
      };
      const leftValue = value(left);
      const rightValue = value(right);
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filter, rules, search, sortDirection, sortKey]);

  const sortableHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      className="table-sort-button"
      onClick={() => {
        if (sortKey === key)
          setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
        else {
          setSortKey(key);
          setSortDirection('asc');
        }
      }}
    >
      {label}
      {sortKey === key ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <section className="pattern-discovery-evidence" aria-labelledby="pattern-rule-evidence-title">
      <div className="pattern-discovery-results-heading">
        <div>
          <h4 id="pattern-rule-evidence-title">{copy.evidenceTitle}</h4>
          <p className="muted">{copy.evidenceExplanation}</p>
        </div>
        <span>
          {filteredRules.length} / {rules.length}
        </span>
      </div>
      <div className="pattern-discovery-evidence-controls">
        <label>
          {copy.evidenceCategoryFilter}
          <select value={filter} onChange={(event) => setFilter(event.target.value as RuleFilter)}>
            <option value="winners">{copy.evidenceWinnerRules}</option>
            <option value="all">{copy.evidenceAllCategories}</option>
            <option value="Edge">Edge</option>
            <option value="Consistency">Consistency</option>
            <option value="Robustness">Robustness</option>
            <option value="Copyability">Copyability</option>
            <option value="Unknown">{copy.evidenceUnknownCategory}</option>
          </select>
        </label>
        <label>
          {copy.evidenceSearch}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.evidenceSearchPlaceholder}
          />
        </label>
      </div>
      <DataTable
        enableColumnHiding
        columnVisibilityStorageKey="vantage-pattern-discovery-rule-evidence-columns"
        wrapClassName="table-wrap copytrade-table-wrap"
        tableClassName="copytrade-table pattern-rule-evidence-table"
        rows={filteredRules}
        getRowKey={(row, index) => `${row.feature ?? 'rule'}-${index}`}
        rowProps={(row) => ({
          className: `pattern-discovery-evidence-row pattern-discovery-evidence-row-${evidenceToneFor(row) ?? 'none'}`,
          onClick: () => onSelectRule(row),
          tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') onSelectRule(row);
          },
        })}
        emptyMessage={copy.evidenceEmpty}
        columns={[
          {
            key: 'feature',
            header: sortableHeader('feature', copy.evidenceFeature),
            render: (row) => labelFor(row.feature),
          },
          {
            key: 'category',
            header: sortableHeader('category', copy.evidenceCategory),
            render: (row) => categoryFor(row),
          },
          {
            key: 'condition',
            header: copy.evidenceCondition,
            render: (row) => conditionText(row.conditions),
            hidden: compact,
          },
          {
            key: 'discoveryEffect',
            header: sortableHeader('discoveryEffect', copy.evidenceDiscoveryEffect),
            render: (row) => formatEffect(row.effect, row.kind),
            cellProps: (row) => ({
              className:
                typeof row.effect === 'number'
                  ? row.effect >= 0
                    ? 'positive'
                    : 'negative'
                  : undefined,
            }),
          },
          {
            key: 'validationEffect',
            header: sortableHeader('validationEffect', copy.evidenceValidationEffect),
            render: (row) =>
              formatEffect(row.validation?.effect_vs_all ?? row.validation?.coefficient, row.kind),
            cellProps: (row) => ({
              className:
                typeof row.validation?.effect_vs_all === 'number'
                  ? row.validation.effect_vs_all >= 0
                    ? 'positive'
                    : 'negative'
                  : undefined,
            }),
          },
          {
            key: 'samples',
            header: copy.evidenceSamples,
            render: (row) =>
              `${formatNumber(row.discovery_sample_size)} / ${formatNumber(row.validation?.sample_size)}`,
            hidden: compact,
          },
          {
            key: 'wallets',
            header: copy.evidenceWallets,
            render: (row) =>
              `${formatNumber(row.discovery_wallets)} / ${formatNumber(row.validation?.wallets)}`,
            hidden: compact,
          },
          {
            key: 'groups',
            header: copy.evidenceGroups,
            render: (row) =>
              `${formatNumber(row.discovery_independence_groups)} / ${formatNumber(row.validation?.independence_groups)}`,
            hidden: compact,
          },
          {
            key: 'history',
            header: copy.evidenceHistory,
            render: (row) => historicalLabel(row),
            hidden: compact,
          },
          {
            key: 'status',
            header: sortableHeader('status', copy.evidenceStatus),
            render: (row) => statusLabel(row),
          },
          {
            key: 'significance',
            header: copy.evidenceSignificance,
            render: (row) => `p ${formatPValue(row.p_value)} · q ${formatPValue(row.q_value)}`,
            hidden: compact,
          },
          {
            key: 'weighting',
            header: copy.evidenceWeighting,
            render: (row) => row.weighting ?? row.validation?.weighting ?? '—',
            hidden: compact,
          },
          {
            key: 'promotion',
            header: copy.evidencePromotion,
            render: (row) =>
              `${row.promoted === undefined ? '—' : row.promoted ? 'Promoted' : 'Not promoted'} · ${row.historical_stability?.status === 'stable' ? 'Stable' : (row.historical_stability?.status ?? '—')}`,
            hidden: compact,
          },
        ]}
        rotateHeaders={!compact}
      />
      <p className="pattern-discovery-evidence-legend muted">{copy.evidenceLegend}</p>
    </section>
  );
};
