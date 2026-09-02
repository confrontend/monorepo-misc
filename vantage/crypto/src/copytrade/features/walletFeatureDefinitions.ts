/**
 * Semantic version of the canonical GMGN wallet-feature contract.
 *
 * A pure code move does not change this value. Change it whenever a feature identifier, window,
 * cost-basis convention, pairing convention, or calculation meaning changes.
 */
export const WALLET_FEATURE_ENGINE_VERSION = 'gmgn-wallet-features-v1-compat';

export type WalletFeatureCategory = 'edge' | 'consistency' | 'robustness' | 'copyability';

export type WalletFeatureSourceClass =
  'raw_activity' | 'pre_window_context' | 'token_context' | 'outcome';

export type WalletFeatureUnit = 'count' | 'usd' | 'percent' | 'seconds' | 'trades_per_active_day';

/** Existing consumers that can safely use a registered wallet feature. */
export type WalletFeatureApplicationMode =
  | 'pattern_discovery'
  | 'decision_weighting'
  | 'decision_hyperactivity_penalty'
  | 'decision_fast_trading_penalty'
  | 'live_evaluation'
  | 'live_promoted_rule';

type WalletFeatureDefinitionShape = {
  identifier: `prior_wallet_${string}`;
  category: WalletFeatureCategory | null;
  sourceClass: WalletFeatureSourceClass;
  unit: WalletFeatureUnit;
  pointInTimeEligible: boolean;
  applicationModes: readonly WalletFeatureApplicationMode[];
};

const PATTERN_AND_LIVE = ['pattern_discovery', 'live_evaluation'] as const;
const WEIGHTED_LIVE_RULE = [
  'pattern_discovery',
  'decision_weighting',
  'live_evaluation',
  'live_promoted_rule',
] as const;

/**
 * Canonical metadata for the existing Pattern Discovery `prior_wallet_*` vocabulary.
 *
 * This registry is additive for now: existing consumers retain their current mappings until they
 * are migrated explicitly. Identifiers and application modes mirror the current allowlist,
 * Decision Lab category/penalty handling, and Live Evaluation feature support.
 */
export const WALLET_FEATURE_DEFINITIONS = [
  {
    identifier: 'prior_wallet_trade_count',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'count',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_hyperactivity_penalty'],
  },
  {
    identifier: 'prior_wallet_buy_volume_usd',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'usd',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_hyperactivity_penalty'],
  },
  {
    identifier: 'prior_wallet_buy_count',
    category: 'copyability',
    sourceClass: 'raw_activity',
    unit: 'count',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_weighting', 'decision_hyperactivity_penalty'],
  },
  {
    identifier: 'prior_wallet_sell_count',
    category: 'copyability',
    sourceClass: 'raw_activity',
    unit: 'count',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_weighting', 'decision_hyperactivity_penalty'],
  },
  {
    identifier: 'prior_wallet_sell_volume_usd',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'usd',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_hyperactivity_penalty'],
  },
  {
    identifier: 'prior_wallet_realized_profit_usd',
    category: 'edge',
    sourceClass: 'raw_activity',
    unit: 'usd',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_median_return_percent',
    category: 'edge',
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_win_rate_percent',
    category: 'consistency',
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_positive_day_percent',
    category: 'consistency',
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_best_token_profit_share_percent',
    category: 'robustness',
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_median_hold_seconds',
    category: 'copyability',
    sourceClass: 'pre_window_context',
    unit: 'seconds',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
  {
    identifier: 'prior_wallet_under_15_seconds_percent',
    category: 'copyability',
    sourceClass: 'pre_window_context',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: [...PATTERN_AND_LIVE, 'decision_weighting', 'decision_fast_trading_penalty'],
  },
  {
    identifier: 'prior_wallet_paired_trade_count',
    category: null,
    sourceClass: 'pre_window_context',
    unit: 'count',
    pointInTimeEligible: true,
    applicationModes: PATTERN_AND_LIVE,
  },
  {
    identifier: 'prior_wallet_distinct_token_count',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'count',
    pointInTimeEligible: true,
    applicationModes: PATTERN_AND_LIVE,
  },
  {
    identifier: 'prior_wallet_trades_per_active_day',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'trades_per_active_day',
    pointInTimeEligible: true,
    applicationModes: PATTERN_AND_LIVE,
  },
  {
    identifier: 'prior_wallet_median_buy_size_usd',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'usd',
    pointInTimeEligible: true,
    applicationModes: PATTERN_AND_LIVE,
  },
  {
    identifier: 'prior_wallet_return_volatility_percent',
    category: null,
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: PATTERN_AND_LIVE,
  },
  {
    identifier: 'prior_wallet_top3_token_profit_share_percent',
    category: 'robustness',
    sourceClass: 'raw_activity',
    unit: 'percent',
    pointInTimeEligible: true,
    applicationModes: WEIGHTED_LIVE_RULE,
  },
] as const satisfies readonly WalletFeatureDefinitionShape[];

export type WalletFeatureIdentifier = (typeof WALLET_FEATURE_DEFINITIONS)[number]['identifier'];
export type WalletFeatureDefinition = (typeof WALLET_FEATURE_DEFINITIONS)[number];

export const WALLET_FEATURE_IDENTIFIERS = WALLET_FEATURE_DEFINITIONS.map(
  ({ identifier }) => identifier,
) as readonly WalletFeatureIdentifier[];

const walletFeatureByIdentifier = new Map<WalletFeatureIdentifier, WalletFeatureDefinition>(
  WALLET_FEATURE_DEFINITIONS.map((definition) => [definition.identifier, definition]),
);

export const isWalletFeatureIdentifier = (value: string): value is WalletFeatureIdentifier =>
  walletFeatureByIdentifier.has(value as WalletFeatureIdentifier);

export const getWalletFeatureDefinition = (identifier: string): WalletFeatureDefinition | null =>
  walletFeatureByIdentifier.get(identifier as WalletFeatureIdentifier) ?? null;

/**
 * Category lookup for persisted patterns. The concentration alias preserves compatibility with
 * older cached reports whose feature predates the current explicit registry vocabulary.
 */
export const walletFeatureCategory = (identifier: string): WalletFeatureCategory | null => {
  const registered = getWalletFeatureDefinition(identifier);
  if (registered) return registered.category;
  return identifier.startsWith('prior_wallet_') && identifier.includes('concentration')
    ? 'robustness'
    : null;
};

export const walletFeatureSupportsApplication = (
  identifier: string,
  applicationMode: WalletFeatureApplicationMode,
): boolean => {
  const definition = getWalletFeatureDefinition(identifier);
  return (
    (definition?.applicationModes as readonly WalletFeatureApplicationMode[] | undefined)?.includes(
      applicationMode,
    ) ?? false
  );
};

export const walletFeaturesForApplication = (
  applicationMode: WalletFeatureApplicationMode,
): readonly WalletFeatureDefinition[] =>
  WALLET_FEATURE_DEFINITIONS.filter((definition) =>
    (definition.applicationModes as readonly WalletFeatureApplicationMode[]).includes(
      applicationMode,
    ),
  );
