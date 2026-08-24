import { create } from 'zustand';

type RosterStore = {
  selectedRosterSnapshotId: number | null;
  setSelectedRosterSnapshotId: (id: number | null) => void;
};

// The selected GMGN roster snapshot is read by every copy-trade data loader (GMGN stats,
// historical consistency, scrutiny, elimination, copy simulation, exports) and written from
// roster import/sync flows — a genuinely global, cross-cutting piece of UI state, not just one
// component's local concern. See ui/main.tsx call sites for `selectedRosterSnapshotId`.
export const useRosterStore = create<RosterStore>((set) => ({
  selectedRosterSnapshotId: null,
  setSelectedRosterSnapshotId: (id) => set({ selectedRosterSnapshotId: id }),
}));
