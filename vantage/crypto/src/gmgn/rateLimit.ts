/**
 * Process-wide GMGN request gate.
 *
 * GMGN's Trading API documentation specifies one request every five seconds per API key. All
 * server-side GMGN CLI calls use this same gate, so leaderboard, wallet activity/stats, signal
 * capture, and probes cannot start requests back-to-back inside this process. This is a request-
 * start interval, not a timeout: a slow request may still be in flight when the next slot opens.
 * Browser-extension traffic and separately started Node processes are outside this server gate.
 */
export const GMGN_REQUEST_SPACING_MS = 5_000;

let nextGmgnRequestAt = 0;
let gmgnRequestQueue: Promise<void> = Promise.resolve();

/** Wait for the next globally scheduled GMGN request slot. */
export const waitForGmgnRequest = async (): Promise<void> => {
  const turn = gmgnRequestQueue.then(async () => {
    const delay = nextGmgnRequestAt - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    nextGmgnRequestAt = Date.now() + GMGN_REQUEST_SPACING_MS;
  });
  gmgnRequestQueue = turn.catch(() => undefined);
  await turn;
};
