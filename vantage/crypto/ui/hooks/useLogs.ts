import { useState } from 'react';
import { api } from '../App.js';
import type { DiagnosticLog } from '../types.js';

export function useLogs(setMessage: (message: string) => void) {
  const [logs, setLogs] = useState<DiagnosticLog[] | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const loadLogs = async () => {
    setLoadingLogs(true);
    try {
      setLogs(await api<DiagnosticLog[]>('/api/logs?limit=50'));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingLogs(false);
    }
  };

  return { logs, loadingLogs, loadLogs };
}
