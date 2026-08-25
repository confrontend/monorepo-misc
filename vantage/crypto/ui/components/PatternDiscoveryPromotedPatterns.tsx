import { useMemo, useState } from 'react';
import { DataTable } from './DataTable.js';
import { conditionText, labelFor } from './PatternDiscoveryRuleDialog.js';
import { UI_STRINGS } from '../strings.js';

type Pattern = {
  feature?: string;
  kind?: string;
  conditions?: unknown;
  effect?: number | null;
  validationStatus?: string;
  validation?: { effect_vs_all?: number | null; coefficient?: number | null };
  historical_stability?: { status?: string; blocks?: number; surviving_blocks?: number };
};

type Report = { patterns: Pattern[] };

type Sensitivity = {
  thresholds: Array<{
    minimumCoveragePercent: number;
    promotedPatterns: number;
    historicalStablePatterns: number;
    reportAvailable: boolean;
  }>;
  reportsByCoverage?: Record<string, Report>;
  crossCoveragePromotedPatterns?: Array<{
    pattern: Pattern;
    supportingCoveragePercent: number[];
  }>;
};

type View = 'cross' | '90' | '95' | '100';

const identity = (pattern: Pattern): string =>
  JSON.stringify({
    feature: pattern.feature ?? null,
    kind: pattern.kind ?? null,
    conditions: pattern.conditions ?? null,
  });

const effect = (pattern: Pattern): number | null =>
  typeof pattern.effect === 'number' && Number.isFinite(pattern.effect) ? pattern.effect : null;

const validationEffect = (pattern: Pattern): number | null => {
  const value = pattern.validation?.effect_vs_all ?? pattern.validation?.coefficient;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const formatEffect = (value: number | null): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

export const PatternDiscoveryPromotedPatterns = ({
  sensitivity,
  onSelectPattern,
}: {
  sensitivity: Sensitivity;
  onSelectPattern?: (pattern: Pattern) => void;
}) => {
  const copy = UI_STRINGS.patternDiscovery;
  const [view, setView] = useState<View>('cross');
  const crossPatterns = sensitivity.crossCoveragePromotedPatterns ?? [];
  const selectedReport = view === 'cross' ? null : sensitivity.reportsByCoverage?.[view];
  const rows = useMemo(() => {
    if (view === 'cross') {
      return crossPatterns.map(({ pattern, supportingCoveragePercent }) => ({
        key: `cross-${identity(pattern)}`,
        pattern,
        coverage: supportingCoveragePercent.join(', ') + '%',
        supportCount: supportingCoveragePercent.length,
      }));
    }
    const seen = new Set<string>();
    return (selectedReport?.patterns ?? [])
      .filter(
        (pattern) =>
          pattern.validationStatus === 'validation survivor' &&
          pattern.historical_stability?.status === 'stable',
      )
      .filter((pattern) => {
        const key = identity(pattern);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((pattern) => ({
        key: `${view}-${identity(pattern)}`,
        pattern,
        coverage: `${view}%`,
        supportCount: 1,
      }));
  }, [crossPatterns, selectedReport, view]);

  const selectedCount = view === 'cross' ? crossPatterns.length : rows.length;

  return (
    <section className="pattern-discovery-promoted" aria-labelledby="pattern-promoted-title">
      <div className="pattern-discovery-results-heading">
        <div>
          <h4 id="pattern-promoted-title">{copy.promotedTitle}</h4>
          <p className="muted">{copy.promotedExplanation}</p>
        </div>
        <strong>{selectedCount}</strong>
      </div>
      <div className="pattern-discovery-evidence-controls">
        <label>
          {copy.promotedViewLabel}
          <select value={view} onChange={(event) => setView(event.target.value as View)}>
            <option value="cross">{copy.promotedCrossCoverage}</option>
            <option value="90">90% coverage</option>
            <option value="95">95% coverage</option>
            <option value="100">100% coverage</option>
          </select>
        </label>
      </div>
      <DataTable
        enableColumnHiding
        columnVisibilityStorageKey="vantage-pattern-discovery-promoted-columns"
        tableClassName="copytrade-table pattern-promoted-table"
        rows={rows}
        getRowKey={(row) => row.key}
        rowProps={(row) =>
          onSelectPattern
            ? {
                className: 'pattern-discovery-promoted-row',
                onClick: () => onSelectPattern(row.pattern),
                tabIndex: 0,
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectPattern(row.pattern);
                },
              }
            : undefined
        }
        emptyMessage={copy.promotedEmpty}
        columns={[
          {
            key: 'feature',
            header: copy.evidenceFeature,
            render: (row) => labelFor(row.pattern.feature),
          },
          {
            key: 'condition',
            header: copy.evidenceCondition,
            render: (row) => conditionText(row.pattern.conditions),
          },
          {
            key: 'coverage',
            header: view === 'cross' ? copy.promotedSupport : copy.promotedCoverage,
            render: (row) =>
              view === 'cross' ? `${row.coverage} (${row.supportCount} runs)` : row.coverage,
          },
          {
            key: 'discoveryEffect',
            header: copy.evidenceDiscoveryEffect,
            render: (row) => formatEffect(effect(row.pattern)),
            cellProps: (row) => ({
              className: (effect(row.pattern) ?? 0) >= 0 ? 'positive' : 'negative',
            }),
          },
          {
            key: 'validationEffect',
            header: copy.evidenceValidationEffect,
            render: (row) => formatEffect(validationEffect(row.pattern)),
            cellProps: (row) => ({
              className: (validationEffect(row.pattern) ?? 0) >= 0 ? 'positive' : 'negative',
            }),
          },
          {
            key: 'stability',
            header: copy.promotedStability,
            render: (row) => {
              const stability = row.pattern.historical_stability;
              return stability?.blocks !== undefined
                ? `${stability.surviving_blocks ?? 0} / ${stability.blocks}`
                : (stability?.status ?? '—');
            },
          },
        ]}
      />
      <p className="pattern-discovery-evidence-legend muted">{copy.promotedLegend}</p>
    </section>
  );
};
