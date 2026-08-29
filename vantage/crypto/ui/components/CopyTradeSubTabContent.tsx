import type { ApiClient } from '../httpClient.js';
import { ApiReference } from './ApiReference.js';
import { ExperimentalDecisionLab } from './ExperimentalDecisionLab.js';
import { LiveEvaluation } from './LiveEvaluation.js';
import type { CopyTradeSubTab } from '../types.js';

type CopyTradeSubTabContentProps = {
  activeTab: CopyTradeSubTab;
  api: ApiClient;
};

export function CopyTradeSubTabContent({ activeTab, api }: CopyTradeSubTabContentProps) {
  if (activeTab === 'api-reference') return <ApiReference api={api} />;
  if (activeTab === 'experimental-decision') return <ExperimentalDecisionLab api={api} />;
  if (activeTab === 'live-evaluation') return <LiveEvaluation api={api} />;
  return null;
}
