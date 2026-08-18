// Shared between fetch.ts (enforces it) and estimate.ts (projects against it), split out to
// avoid a circular import between the two modules.
export const MAX_REQUESTS_PER_WALLET = 200;

/**
 * Most trades stored per wallet per UTC calendar day. Without this, a single exceptionally
 * dense day (a bot-like wallet doing thousands of trades in 24h) can dominate a wallet's
 * entire stored sample, skewing later analysis toward whichever days happened to be busiest
 * rather than giving every day in the window a comparable footprint.
 *
 * This does NOT reduce request cost for a dense day — GMGN's activity endpoint only supports
 * cursor pagination, not a time-range filter (confirmed: `gmgn-cli portfolio activity --help`
 * has no start/end option), so every trade in a dense day still has to be paged through once to
 * get past it. It only bounds what gets stored. 500 = 10 pages at PAGE_SIZE=50, a round number
 * well above what a normal (non-bot) trader does in a day, chosen as a ceiling rather than a
 * target — most days for most wallets never come close to it.
 */
export const DAILY_TRADE_INSERT_CAP = 500;
