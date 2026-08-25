export const UI_STRINGS = {
  patternDiscovery: {
    gridEyebrow: 'SHARED-GRID RESULT',
    gridTitle: 'What did the full discovery run learn?',
    gridStatus: (eligibleLevels: number, availableLevels: number): string =>
      eligibleLevels > 0
        ? `Validated patterns exist at ${eligibleLevels} of ${availableLevels} coverage levels`
        : 'No validated pattern at any coverage level',
    completedLevels: 'coverage levels completed',
    eligibleLevels: 'levels with validated, historically stable patterns',
    highestEligibleLevel: 'highest coverage level with eligible patterns',
    unavailableLevels: 'coverage levels unavailable',
    gridExplanation:
      'This is the full 50–100% grid result. Decision Lab changes category weights only when validated patterns repeat across multiple coverage levels.',
    strictEyebrow: 'STRICT 100% COVERAGE DETAIL',
    strictTitle: 'What happened at the 100% level?',
    strictStatusWithEvidence: 'Evidence repeated at 100% coverage',
    strictStatusWithoutEvidence: 'No reliable rule at 100% coverage',
    strictSurvivors: '100%-coverage rules that survived a second test',
    strictExplanation:
      'The details below describe only the strict 100% grid member. They do not replace the shared-grid result above.',
    sensitivityTitle: 'Coverage-level results',
    sensitivityExplanation:
      'Each row uses the same wallet-balanced engine. “Eligible” is local to that coverage level; Decision Lab still requires repetition across levels before changing weights.',
    sensitivityRange: '50% → 100% · 5% steps',
    stableEligibleHeader: 'Stable / eligible',
    strictRulesTitle: '100% coverage rule details',
    strictRulesExplanation:
      'These rules belong only to the strict 100% grid member. Click a rule for its explanation and visual summary.',
    strictRuleCountSuffix: 'at 100%',
    noStrictRules:
      'No rule survived at the 100% level. This does not mean the shared-grid discovery failed.',
    evidenceTitle: 'Per-rule evidence comparison',
    evidenceExplanation:
      'Winner rules are shown first: positive in discovery and validation when both effects are available. Choose All categories to inspect the complete evidence table.',
    evidenceCategoryFilter: 'Category',
    evidenceWinnerRules: 'Winner rules · positive in discovery and validation',
    evidenceAllCategories: 'All categories',
    evidenceUnknownCategory: 'Unknown / unmapped',
    evidenceSearch: 'Find a rule',
    evidenceSearchPlaceholder: 'Feature, condition, or status',
    evidenceEmpty: 'No rules match the selected filters.',
    evidenceFeature: 'Rule / feature',
    evidenceCategory: 'Decision Lab group',
    evidenceCondition: 'Condition',
    evidenceDiscoveryEffect: 'Discovery effect',
    evidenceValidationEffect: 'Validation effect',
    evidenceSamples: 'Samples D / V',
    evidenceWallets: 'Wallets D / V',
    evidenceGroups: 'Groups D / V',
    evidenceHistory: 'Historical blocks survived / total',
    evidenceStatus: 'Validation status',
    evidenceSignificance: 'Significance',
    evidenceWeighting: 'Weighting',
    evidencePromotion: 'Promoted / stable',
    evidenceLegend:
      'D / V means discovery / validation. “Validated” means the report explicitly marked a validation survivor; it is not a percentage success rate. Historical stability counts blocks that survived. Promoted is shown only when the report provides it. Effects are associations, not guaranteed profit.',
    exportPageData: 'Export all page data (.json)',
    promotedTitle: 'Promoted and historically stable patterns',
    promotedExplanation:
      'These are the actual rule names and conditions that survived validation and repeated across coverage levels. They are associations, not guaranteed profit and not yet a single golden rule.',
    promotedViewLabel: 'Show',
    promotedCrossCoverage: 'Cross-coverage promoted patterns',
    promotedCoverage: 'Coverage',
    promotedSupport: 'Supported at',
    promotedStability: 'Stable blocks',
    promotedEmpty: 'No promoted/stable patterns are available for this coverage view.',
    promotedLegend:
      'Cross-coverage patterns repeat as validation survivors with historical stability in at least two coverage reports. Counts at 90%, 95%, and 100% are shown from their respective cached reports.',
  },
} as const;
