import { useCallback, useEffect, useMemo } from 'react';
import type { ApiClient } from '../httpClient.js';
import { ApiReference } from './ApiReference.js';
import { ExperimentalDecisionLab } from './ExperimentalDecisionLab.js';
import { LiveEvaluation } from './LiveEvaluation.js';
import { DataWorkflow } from './data/DataWorkflow.js';
import { SolanaBenchmark } from './SolanaBenchmark.js';
import type { CopyTradeSubTab } from '../types.js';

type CopyTradeSubTabContentProps = {
  activeTab: CopyTradeSubTab;
  api: ApiClient;
};

export function CopyTradeSubTabContent({ activeTab, api }: CopyTradeSubTabContentProps) {
  const controller = useMemo(() => new AbortController(), [activeTab]);
  useEffect(() => () => controller.abort(), [controller]);
  const scopedApi = useCallback<ApiClient>(
    (url, init) => api(url, init?.signal ? init : { ...init, signal: controller.signal }),
    [api, controller],
  );

  if (activeTab === 'data') return <DataWorkflow api={scopedApi} />;
  if (activeTab === 'api-reference') return <ApiReference api={scopedApi} />;
  if (activeTab === 'experimental-decision') return <ExperimentalDecisionLab api={scopedApi} />;
  if (activeTab === 'live-evaluation') return <LiveEvaluation api={scopedApi} />;
  if (activeTab === 'solana-benchmark') return <SolanaBenchmark api={scopedApi} />;
  return null;
}
