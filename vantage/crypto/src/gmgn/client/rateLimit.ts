/**
 * Process-wide GMGN request gate.
 *
 * Experimental request gate for the server-side GMGN calls. We use a one-second start interval
 * to measure whether the provider tolerates a faster cadence; HTTP 429 responses still stop the
 * run and persist a resumable rate-limit state. This is a request-start interval, not a timeout:
 * a slow request may still be in flight when the next slot opens.
 * Browser-extension traffic and separately started Node processes are outside this server gate.
 */
export const GMGN_REQUEST_SPACING_MS = 1_000;

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
