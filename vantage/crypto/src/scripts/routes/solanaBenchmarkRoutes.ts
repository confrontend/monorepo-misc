import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { readBenchmarkRun, startBenchmarkRun } from '../../solana/benchmarkRuns.js';

export interface SolanaBenchmarkRouteRequest {
  method: string | undefined;
  url: URL;
  request: IncomingMessage;
  readJsonBody: () => Promise<unknown>;
}
export interface SolanaBenchmarkRouteContext {
  database: DatabaseSync;
  respond: (status: number, value: unknown) => void;
}
export type SolanaBenchmarkRoute = (
  request: SolanaBenchmarkRouteRequest,
  context: SolanaBenchmarkRouteContext,
) => Promise<boolean>;

export const createSolanaBenchmarkRoutes = (): SolanaBenchmarkRoute[] => [
  async ({ method, url }, { database, respond }) => {
    if (url.pathname !== '/api/copytrade/solana-benchmark') return false;
    if (method === 'GET') respond(200, { run: readBenchmarkRun(database) });
    else if (method === 'POST') respond(202, { run: startBenchmarkRun(database) });
    else respond(405, { error: 'Method not allowed' });
    return true;
  },
];
