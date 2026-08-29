export type DecisionLabCategory = 'edge' | 'consistency' | 'robustness' | 'copyability';

export const weightCategoryForFeature = (feature: string): DecisionLabCategory | null => {
  if (feature.includes('median_return') || feature.includes('realized_profit')) return 'edge';
  if (feature.includes('positive_day') || feature.includes('win_rate')) return 'consistency';
  if (feature.includes('token_profit_share') || feature.includes('concentration'))
    return 'robustness';
  if (
    feature.includes('median_hold') ||
    feature.includes('under_15_seconds') ||
    feature.includes('buy_count') ||
    feature.includes('sell_count')
  )
    return 'copyability';
  return null;
};
