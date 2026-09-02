import { create } from 'zustand';
import type { DataWorkflowRosterResponse } from '../components/data/dataWorkflowRosterTypes.js';
import type { DataWorkflowState } from '../components/data/dataWorkflowTypes.js';

type DataWorkflowStore = DataWorkflowState & {
  reset: (targetDays: number) => void;
  setTargetDays: (targetDays: number) => void;
  setStatusResponse: (statusResponse: DataWorkflowState['statusResponse']) => void;
  setCoverage: (coverage: DataWorkflowState['coverage']) => void;
  setReadiness: (readiness: DataWorkflowState['readiness']) => void;
  setLoadingStatus: (loading: boolean) => void;
  setLoadingCoverage: (loading: boolean) => void;
  setLoadingReadiness: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCoverageError: (error: string | null) => void;
  setReadinessError: (error: string | null) => void;
  setRosterResponse: (response: DataWorkflowRosterResponse | null) => void;
  setLoadingRoster: (loading: boolean) => void;
  setRosterLoadError: (error: string | null) => void;
  setSelectedWallets: (wallets: Set<string>) => void;
  toggleWallet: (walletAddress: string) => void;
  setWalletSelectionOpen: (open: boolean) => void;
  setBusyAction: (action: DataWorkflowState['busyAction']) => void;
  setRosterBusy: (action: DataWorkflowState['rosterBusy']) => void;
  setRosterError: (error: string | null) => void;
  setRetryingWallet: (walletAddress: string | null) => void;
};

const initialState = (targetDays: number): DataWorkflowState => ({
  targetDays,
  statusResponse: null,
  coverage: null,
  readiness: null,
  loadingStatus: true,
  // These detail endpoints are intentionally loaded only after an explicit workflow action or
  // refresh. They are expensive evidence scans and should not delay the initial Data tab load.
  loadingCoverage: false,
  loadingReadiness: false,
  error: null,
  coverageError: null,
  readinessError: null,
  rosterResponse: null,
  loadingRoster: true,
  rosterLoadError: null,
  selectedWallets: new Set(),
  walletSelectionOpen: false,
  busyAction: null,
  rosterBusy: null,
  rosterError: null,
  retryingWallet: null,
});

export const useDataWorkflowStore = create<DataWorkflowStore>((set) => ({
  ...initialState(30),
  reset: (targetDays) => set(initialState(targetDays)),
  setTargetDays: (targetDays) => set({ targetDays }),
  setStatusResponse: (statusResponse) => set({ statusResponse }),
  setCoverage: (coverage) => set({ coverage }),
  setReadiness: (readiness) => set({ readiness }),
  setLoadingStatus: (loadingStatus) => set({ loadingStatus }),
  setLoadingCoverage: (loadingCoverage) => set({ loadingCoverage }),
  setLoadingReadiness: (loadingReadiness) => set({ loadingReadiness }),
  setError: (error) => set({ error }),
  setCoverageError: (coverageError) => set({ coverageError }),
  setReadinessError: (readinessError) => set({ readinessError }),
  setRosterResponse: (rosterResponse) => set({ rosterResponse }),
  setLoadingRoster: (loadingRoster) => set({ loadingRoster }),
  setRosterLoadError: (rosterLoadError) => set({ rosterLoadError }),
  setSelectedWallets: (selectedWallets) => set({ selectedWallets: new Set(selectedWallets) }),
  toggleWallet: (walletAddress) =>
    set((state) => {
      const selectedWallets = new Set(state.selectedWallets);
      if (selectedWallets.has(walletAddress)) selectedWallets.delete(walletAddress);
      else selectedWallets.add(walletAddress);
      return { selectedWallets };
    }),
  setWalletSelectionOpen: (walletSelectionOpen) => set({ walletSelectionOpen }),
  setBusyAction: (busyAction) => set({ busyAction }),
  setRosterBusy: (rosterBusy) => set({ rosterBusy }),
  setRosterError: (rosterError) => set({ rosterError }),
  setRetryingWallet: (retryingWallet) => set({ retryingWallet }),
}));
