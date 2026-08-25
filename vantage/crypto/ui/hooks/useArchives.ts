import { useState } from 'react';
import { api } from '../App.js';
import type { GmgnArchiveSummary } from '../types.js';

export function useArchives(setMessage: (message: string) => void) {
  const [archives, setArchives] = useState<GmgnArchiveSummary[] | null>(null);
  const [loadingArchives, setLoadingArchives] = useState(false);

  const loadArchives = async () => {
    setLoadingArchives(true);
    try {
      setArchives(await api<GmgnArchiveSummary[]>('/api/gmgn/archives'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingArchives(false);
    }
  };

  return { archives, loadingArchives, loadArchives };
}
