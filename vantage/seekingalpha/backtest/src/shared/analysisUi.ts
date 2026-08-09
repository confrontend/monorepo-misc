import type { HistoryWindow, Rating, SignalPolicy, TickerResult } from '../data';

export type HistoryOption = { value: HistoryWindow; label: string; shortLabel: string };

export const buildHistoryOptions = (values: HistoryWindow[]): HistoryOption[] => values.map((value) => {
  if (value === '7d') return { value, label: 'Past 7 days', shortLabel: '7 days' };
  if (value === 'all') return { value, label: 'All available data', shortLabel: 'All' };
  const months = Number.parseInt(value, 10);
  const duration = `${months} ${months === 1 ? 'month' : 'months'}`;
  return { value, label: `Past ${duration}`, shortLabel: duration };
});

export const fallbackHistoryOptions = buildHistoryOptions(['7d', '1m', '3m', '6m', '12m', 'all']);

export const policyOptions: Array<{ value: SignalPolicy; label: string; shortLabel: string }> = [
  { value: 'long-exit-hold', label: 'Long-only · Exit on Hold', shortLabel: 'Exit on Hold' },
  { value: 'long-hold-through', label: 'Long-only · Hold through Hold', shortLabel: 'Hold through Hold' },
  { value: 'long-short', label: 'Long-short · Sell ratings short', shortLabel: 'Long-short' },
];

export const policyLabels: Record<SignalPolicy, string> = Object.fromEntries(policyOptions.map((option) => [option.value, option.label])) as Record<SignalPolicy, string>;

export const policyExitRules: Record<SignalPolicy, string> = {
  'long-exit-hold': 'Exit when rating falls to Hold, Sell, or Strong Sell',
  'long-hold-through': 'Keep the position through Hold; exit on Sell or Strong Sell',
  'long-short': 'Exit to cash on Hold; short on Sell or Strong Sell',
};

export const ratingClass = (rating: TickerResult['latestRating']) => {
  if (rating.includes('Buy')) return 'rating rating-buy';
  if (rating.includes('Sell')) return 'rating rating-sell';
  return 'rating rating-hold';
};

export const signedPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
export const matrixKey = (window: HistoryWindow, policy: SignalPolicy) => `${window}|${policy}`;
export const tierSortOrder: Record<string, number> = { 'Strong Buy': 0, Buy: 1, Hold: 2, Sell: 3, 'Strong Sell': 4 };
export const tierDotColor = (tier: Rating) => (tier.includes('Buy') ? '#65d7aa' : tier.includes('Sell') ? '#ff9297' : '#f0c45e');
