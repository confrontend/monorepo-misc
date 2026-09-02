import {
  walletFeatureCategory,
  type WalletFeatureCategory,
} from './features/walletFeatureDefinitions.js';

export type DecisionLabCategory = WalletFeatureCategory;

export const weightCategoryForFeature = (feature: string): DecisionLabCategory | null =>
  walletFeatureCategory(feature);
