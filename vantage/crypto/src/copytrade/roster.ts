import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The CopyTrade roster: which wallets we are willing to evaluate.
 *
 * The roster is derived from a timestamped GMGN wallet-leaderboard snapshot
 * (`gmgn_wallet_rank_snapshots`). Snapshots may come from the controlled rank refresh endpoint
 * or from a browser capture; either way, the raw response is retained and the roster is a
 * point-in-time input. Trade history and summaries then come from the official API.
 */

/**
 * Tags GMGN applies that indicate the reported performance may not reflect genuine,
 * repeatable trading. Deliberately narrow: only `wash_trader` is a quality claim about the
 * trading itself. Tags like `kol`, `arbitrager`, or `axiom` describe who or what the wallet is,
 * not whether its numbers can be trusted, so they are recorded but never treated as risk.
 */
const RISK_TAGS = new Set(['wash_trader']);

/** Stands in when a wallet's stored risk flags cannot be parsed. Treated as a risk, not as
 *  an absence of one — see listRosterWallets. */
export const UNKNOWN_RISK_FLAG = 'unknown_risk_flags';

export type RosterWallet = {
  walletAddress: string;
  chain: string;
  name: string | null;
  iconUrl: string | null;
  rankPosition: number | null;
  reportedPnl30d: string | null;
  reportedWinrate30d: string | null;
  riskFlags: string[];
};

export type RosterResult = {
  snapshotId: number | null;
  capturedAt: string | null;
  added: number;
  alreadyPresent: number;
  total: number;
};

export type RosterComparison = {
  currentSnapshotId: number | null;
  currentCapturedAt: string | null;
  previousSnapshotId: number | null;
  previousCapturedAt: string | null;
  baselineAvailable: boolean;
  current: RosterWallet[];
  joined: RosterWallet[];
  left: RosterWallet[];
};

export type LeaderboardProvenance = {
  snapshotId: number;
  capturedAt: string;
  window: string | null;
  orderby: string | null;
  requestPath: string | null;
  requestQuery: Record<string, unknown>;
};

export type WalletRankHistory = {
  walletAddress: string;
  leaderboardCaptures: number;
  appearances: number;
  topFiveAppearances: number;
  topFiveMembershipPercent: number | null;
  currentRank: number | null;
  bestRank: number | null;
  worstRank: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
};

/** Source values are preserved verbatim as strings — see the schema migration comment. */
const asSourceText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const asOptionalName = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asOptionalIcon = (item: RankItem): string | null => {
  for (const key of ['avatar_url', 'avatar', 'icon_url', 'icon', 'logo', 'image_url', 'profile_pic', 'twitter_avatar']) {
    const value = item[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
};

const extractRiskFlags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string' && RISK_TAGS.has(tag));
};


type RankItem = Record<string, unknown>;

/**
 * Reads the newest leaderboard snapshot's rank array. Returns an empty list rather than
 * throwing when no snapshot exists or its payload is malformed — an empty roster is a valid
 * state the UI must render, not an error condition.
 */
export const readLatestRankSnapshot = (
  database: DatabaseSync,
): { snapshotId: number | null; capturedAt: string | null; rank: RankItem[] } => {
  const row = database.prepare(
    `SELECT s.id, COALESCE(p.captured_at, s.captured_at) AS capturedAt, s.raw_payload AS rawPayload
     FROM gmgn_wallet_rank_snapshots s
     LEFT JOIN gmgn_wallet_rank_capture_provenance p ON p.id = (
       SELECT p2.id FROM gmgn_wallet_rank_capture_provenance p2
       WHERE p2.snapshot_id = s.id ORDER BY p2.captured_at DESC, p2.id DESC LIMIT 1
     )
     ORDER BY capturedAt DESC, s.id DESC LIMIT 1`,
  ).get() as { id: number; capturedAt: string; rawPayload: string } | undefined;
  if (!row) return { snapshotId: null, capturedAt: null, rank: [] };

  let parsed: unknown;
  try { parsed = JSON.parse(row.rawPayload); } catch { return { snapshotId: row.id, capturedAt: row.capturedAt, rank: [] }; }
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as { data?: unknown; rank?: unknown; list?: unknown } : {};
  const data = root.data;
  const rank = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && !Array.isArray(data)
      ? ((data as { rank?: unknown; list?: unknown }).rank ?? (data as { rank?: unknown; list?: unknown }).list)
      : (root.rank ?? root.list);
  if (!Array.isArray(rank)) return { snapshotId: row.id, capturedAt: row.capturedAt, rank: [] };
  return {
    snapshotId: row.id,
    capturedAt: row.capturedAt,
    rank: rank.filter((item): item is RankItem => item !== null && typeof item === 'object'),
  };
};

/** Reads one exact leaderboard snapshot. Reports must use this when the caller has selected
 * a roster; silently falling back to the newest capture would change the wallet population. */
export const readRankSnapshot = (
  database: DatabaseSync,
  snapshotId: number,
): { snapshotId: number | null; capturedAt: string | null; rank: RankItem[] } => {
  const row = database.prepare(
    `SELECT id, captured_at AS capturedAt, raw_payload AS rawPayload
     FROM gmgn_wallet_rank_snapshots WHERE id = ?`,
  ).get(snapshotId) as { id: number; capturedAt: string; rawPayload: string } | undefined;
  if (!row) return { snapshotId: null, capturedAt: null, rank: [] };
  try {
    const parsed = JSON.parse(row.rawPayload) as { data?: unknown; rank?: unknown; list?: unknown } | null;
    const data = parsed?.data;
    const rank = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && !Array.isArray(data)
        ? ((data as { rank?: unknown; list?: unknown }).rank ?? (data as { rank?: unknown; list?: unknown }).list)
        : (parsed?.rank ?? parsed?.list);
    return {
      snapshotId: row.id,
      capturedAt: row.capturedAt,
      rank: Array.isArray(rank) ? rank.filter((item): item is RankItem => item !== null && typeof item === 'object') : [],
    };
  } catch {
    return { snapshotId: row.id, capturedAt: row.capturedAt, rank: [] };
  }
};

const parseQuery = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

/** Exact request context for a leaderboard snapshot. Legacy snapshots predate the provenance
 * table and honestly return an empty query rather than reconstructing filters from memory. */
export const readLeaderboardProvenance = (
  database: DatabaseSync,
  snapshotId: number,
): LeaderboardProvenance | null => {
  const row = database.prepare(
    `SELECT s.id AS snapshotId, COALESCE(p.captured_at, s.captured_at) AS capturedAt,
            COALESCE(p.window, s.window) AS window, COALESCE(p.orderby, s.orderby) AS orderby,
            p.request_path AS requestPath, p.request_query_json AS requestQueryJson
     FROM gmgn_wallet_rank_snapshots s
     LEFT JOIN gmgn_wallet_rank_capture_provenance p ON p.id = (
       SELECT p2.id FROM gmgn_wallet_rank_capture_provenance p2
       WHERE p2.snapshot_id = s.id ORDER BY p2.captured_at DESC, p2.id DESC LIMIT 1
     )
     WHERE s.id = ?`,
  ).get(snapshotId) as { snapshotId: number; capturedAt: string; window: string | null; orderby: string | null; requestPath: string | null; requestQueryJson: string | null } | undefined;
  if (!row) return null;
  const { requestQueryJson, ...provenance } = row;
  return { ...provenance, requestQuery: parseQuery(requestQueryJson) };
};

export type ProvenanceStatus = 'provenanced' | 'legacy_unprovenanced';

export type LeaderboardSnapshotStatus = {
  snapshotId: number;
  capturedAt: string;
  provenanceStatus: ProvenanceStatus;
  window: string | null;
  orderby: string | null;
  /** Null only for a legacy_unprovenanced snapshot — there is no exact filter to hash. */
  filterHash: string | null;
};

/** A snapshot is `provenanced` exactly when a matching `gmgn_wallet_rank_capture_provenance`
 *  row exists — that table did not exist when the first captures were taken, so those rows can
 *  never gain provenance retroactively (see docs/COPYTRADE_PROSPECTIVE_VALIDATION_PLAN.md §1).
 *  The hash covers window/orderby/requestPath/requestQuery so two captures only count as "the
 *  same filter" when every one of those matches, not just the coarse window/orderby pair. */
export const filterHashFor = (provenance: Pick<LeaderboardProvenance, 'window' | 'orderby' | 'requestPath' | 'requestQuery'>): string =>
  createHash('sha256').update(JSON.stringify({
    window: provenance.window, orderby: provenance.orderby,
    requestPath: provenance.requestPath, requestQuery: provenance.requestQuery,
  })).digest('hex');

export const listLeaderboardSnapshotStatuses = (database: DatabaseSync): LeaderboardSnapshotStatus[] => {
  const rows = database.prepare(
    `SELECT s.id AS snapshotId, s.captured_at AS snapshotCapturedAt,
            p.id AS provenanceId, p.captured_at AS provenanceCapturedAt,
            p.window AS window, p.orderby AS orderby,
            p.request_path AS requestPath, p.request_query_json AS requestQueryJson
     FROM gmgn_wallet_rank_snapshots s
     LEFT JOIN gmgn_wallet_rank_capture_provenance p ON p.snapshot_id = s.id
     ORDER BY s.id ASC`,
  ).all() as unknown as Array<{
    snapshotId: number; snapshotCapturedAt: string; provenanceId: number | null; provenanceCapturedAt: string | null;
    window: string | null; orderby: string | null; requestPath: string | null; requestQueryJson: string | null;
  }>;
  return rows.map((row) => {
    const provenanced = row.provenanceId !== null;
    return {
      snapshotId: row.snapshotId,
      capturedAt: row.provenanceCapturedAt ?? row.snapshotCapturedAt,
      provenanceStatus: provenanced ? 'provenanced' : 'legacy_unprovenanced',
      window: row.window,
      orderby: row.orderby,
      filterHash: provenanced
        ? filterHashFor({ window: row.window, orderby: row.orderby, requestPath: row.requestPath, requestQuery: parseQuery(row.requestQueryJson) })
        : null,
    };
  });
};

export type CaptureHealth = {
  latestSnapshotAt: string | null;
  latestSnapshotId: number | null;
  latestProvenanceStatus: ProvenanceStatus | null;
  latestFilterHash: string | null;
  /** Null unless at least one provenanced (freezable) snapshot exists — a UI action like
   *  "Freeze current roster" should disable itself, not guess, when this is null. */
  latestProvenancedSnapshotId: number | null;
  hoursSinceLastCapture: number | null;
  /** Distinct UTC calendar dates among provenanced captures sharing the latest filter hash.
   *  Deliberately excludes any capture whose filter hash differs — comparing captures made
   *  under different leaderboard filters as one history would misrepresent rank persistence. */
  distinctCaptureDatesForLatestFilter: number;
  legacySnapshotCount: number;
  provenancedSnapshotCount: number;
};

/** Read-only summary for the capture-health panel (Phase 0). Never infers or repairs a missing
 *  filter for a legacy snapshot — an absent filter hash stays absent. */
export const readCaptureHealth = (database: DatabaseSync, now = new Date()): CaptureHealth => {
  const statuses = listLeaderboardSnapshotStatuses(database);
  const legacySnapshotCount = statuses.filter((status) => status.provenanceStatus === 'legacy_unprovenanced').length;
  const provenancedSnapshotCount = statuses.length - legacySnapshotCount;
  const latestProvenancedSnapshotId = [...statuses]
    .filter((status) => status.provenanceStatus === 'provenanced')
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .at(-1)?.snapshotId ?? null;
  if (statuses.length === 0) {
    return {
      latestSnapshotAt: null, latestSnapshotId: null, latestProvenanceStatus: null, latestFilterHash: null,
      latestProvenancedSnapshotId, hoursSinceLastCapture: null, distinctCaptureDatesForLatestFilter: 0,
      legacySnapshotCount, provenancedSnapshotCount,
    };
  }
  const latest = [...statuses].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))[statuses.length - 1];
  const hoursSinceLastCapture = Math.round(((now.getTime() - Date.parse(latest.capturedAt)) / 3_600_000) * 100) / 100;
  const distinctCaptureDatesForLatestFilter = latest.filterHash === null ? 0 : new Set(
    statuses.filter((status) => status.filterHash === latest.filterHash).map((status) => status.capturedAt.slice(0, 10)),
  ).size;
  return {
    latestSnapshotAt: latest.capturedAt,
    latestSnapshotId: latest.snapshotId,
    latestProvenanceStatus: latest.provenanceStatus,
    latestFilterHash: latest.filterHash,
    latestProvenancedSnapshotId,
    hoursSinceLastCapture,
    distinctCaptureDatesForLatestFilter,
    legacySnapshotCount,
    provenancedSnapshotCount,
  };
};

/**
 * Summarizes repeated GMGN leaderboard observations for the requested wallets. Absence from a
 * capture counts against top-five persistence; otherwise a wallet could appear once at rank 1
 * and misleadingly display 100% persistence forever.
 */
export const readWalletRankHistory = (
  database: DatabaseSync,
  walletAddresses: string[],
  currentSnapshotId: number | null,
): WalletRankHistory[] => {
  if (walletAddresses.length === 0) return [];
  const wanted = new Set(walletAddresses);
  const captures = database.prepare(
    `SELECT s.id AS snapshotId, s.captured_at AS snapshotCapturedAt, s.raw_payload AS rawPayload,
            p.id AS provenanceId, p.captured_at AS provenanceCapturedAt
     FROM gmgn_wallet_rank_snapshots s
     LEFT JOIN gmgn_wallet_rank_capture_provenance p ON p.snapshot_id = s.id
     ORDER BY COALESCE(p.captured_at, s.captured_at) ASC, s.id ASC, p.id ASC`,
  ).all() as unknown as Array<{ snapshotId: number; snapshotCapturedAt: string; rawPayload: string; provenanceId: number | null; provenanceCapturedAt: string | null }>;

  type Acc = Omit<WalletRankHistory, 'topFiveMembershipPercent'> & { ranks: number[] };
  const state = new Map<string, Acc>(walletAddresses.map((walletAddress) => [walletAddress, {
    walletAddress, leaderboardCaptures: captures.length, appearances: 0, topFiveAppearances: 0,
    currentRank: null, bestRank: null, worstRank: null, firstObservedAt: null, lastObservedAt: null,
    ranks: [] as number[],
  }]));

  for (const capture of captures) {
    let rank: unknown;
    try { rank = (JSON.parse(capture.rawPayload) as { data?: { rank?: unknown } })?.data?.rank; } catch { continue; }
    if (!Array.isArray(rank)) continue;
    const capturedAt = capture.provenanceCapturedAt ?? capture.snapshotCapturedAt;
    rank.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const address = typeof record.wallet_address === 'string' ? record.wallet_address
        : typeof record.address === 'string' ? record.address : null;
      if (!address || !wanted.has(address)) return;
      const entry = state.get(address)!;
      const position = index + 1;
      entry.appearances += 1;
      if (position <= 5) entry.topFiveAppearances += 1;
      entry.ranks.push(position);
      entry.firstObservedAt ??= capturedAt;
      entry.lastObservedAt = capturedAt;
      if (capture.snapshotId === currentSnapshotId) entry.currentRank = position;
    });
  }

  return [...state.values()].map(({ ranks, ...entry }) => ({
    ...entry,
    topFiveMembershipPercent: entry.leaderboardCaptures === 0 ? null
      : Math.round((entry.topFiveAppearances / entry.leaderboardCaptures) * 1000) / 10,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    worstRank: ranks.length ? Math.max(...ranks) : null,
  }));
};

export const rankItemToWallet = (item: RankItem, index: number, chain: string): RosterWallet | null => {
  const walletAddress = typeof item.wallet_address === 'string' && item.wallet_address.length > 0
    ? item.wallet_address
    : typeof item.address === 'string' && item.address.length > 0 ? item.address : null;
  if (!walletAddress) return null;
  return {
    walletAddress,
    chain,
    // GMGN populates `name` for only ~40% of wallets; twitter_name is the usual fallback.
    name: asOptionalName(item.name) ?? asOptionalName(item.twitter_name),
    iconUrl: asOptionalIcon(item),
    rankPosition: index + 1,
    reportedPnl30d: asSourceText(item.pnl_30d),
    reportedWinrate30d: asSourceText(item.winrate_30d),
    riskFlags: extractRiskFlags(item.tags),
  };
};

export const compareLatestRosterSnapshots = (
  database: DatabaseSync,
  options: { chain?: string; limit?: number } = {},
): RosterComparison => {
  const chain = options.chain ?? 'sol';
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
  const snapshots = database.prepare(
    `SELECT id FROM gmgn_wallet_rank_snapshots ORDER BY captured_at DESC, id DESC LIMIT 2`,
  ).all() as unknown as Array<{ id: number }>;
  const currentSnapshot = snapshots[0] ? readRankSnapshot(database, snapshots[0].id) : { snapshotId: null, capturedAt: null, rank: [] };
  const previousSnapshot = snapshots[1] ? readRankSnapshot(database, snapshots[1].id) : { snapshotId: null, capturedAt: null, rank: [] };
  const toWallets = (snapshot: typeof currentSnapshot): RosterWallet[] => snapshot.rank.slice(0, limit).map((item, index) => rankItemToWallet(item, index, chain)).filter((wallet): wallet is RosterWallet => wallet !== null);
  const current = toWallets(currentSnapshot);
  const previous = toWallets(previousSnapshot);
  const previousSet = new Set(previous.map((wallet) => wallet.walletAddress));
  const currentSet = new Set(current.map((wallet) => wallet.walletAddress));
  return {
    currentSnapshotId: currentSnapshot.snapshotId,
    currentCapturedAt: currentSnapshot.capturedAt,
    previousSnapshotId: previousSnapshot.snapshotId,
    previousCapturedAt: previousSnapshot.capturedAt,
    baselineAvailable: previousSnapshot.snapshotId !== null,
    current,
    joined: current.filter((wallet) => !previousSet.has(wallet.walletAddress)),
    left: previous.filter((wallet) => !currentSet.has(wallet.walletAddress)),
  };
};

/**
 * Populates `copytrade_wallets` from the newest leaderboard snapshot.
 *
 * Idempotent: the UNIQUE(wallet_address, chain, source_snapshot_id) constraint plus
 * INSERT OR IGNORE means re-running against the same snapshot adds nothing. A *new* snapshot
 * creates new rows for the same wallets on purpose — rank position and reported performance
 * are point-in-time facts, and overwriting them would destroy the record of what the
 * leaderboard claimed when we selected the wallet.
 */
export const syncCopyTradeRoster = (
  database: DatabaseSync,
  options: { chain?: string; limit?: number; now?: Date } = {},
): RosterResult => {
  const chain = options.chain ?? 'sol';
  const addedAt = (options.now ?? new Date()).toISOString();
  const { snapshotId, capturedAt, rank } = readLatestRankSnapshot(database);
  if (snapshotId === null) return { snapshotId: null, capturedAt: null, added: 0, alreadyPresent: 0, total: 0 };

  const limited = typeof options.limit === 'number' && options.limit > 0 ? rank.slice(0, options.limit) : rank;
  const insert = database.prepare(
    `INSERT OR IGNORE INTO copytrade_wallets
       (wallet_address, chain, name, icon_url, source_snapshot_id, rank_position,
        reported_pnl_30d, reported_winrate_30d, risk_flags, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let added = 0;
  let alreadyPresent = 0;
  for (const [index, item] of limited.entries()) {
    const wallet = rankItemToWallet(item, index, chain);
    if (!wallet) continue;
    const result = insert.run(
      wallet.walletAddress, wallet.chain, wallet.name, wallet.iconUrl, snapshotId, wallet.rankPosition,
      wallet.reportedPnl30d, wallet.reportedWinrate30d, JSON.stringify(wallet.riskFlags), addedAt,
    );
    if (result.changes > 0) added += 1; else alreadyPresent += 1;
  }
  return { snapshotId, capturedAt, added, alreadyPresent, total: added + alreadyPresent };
};

/**
 * The wallets that make up "the top N traders" right now.
 *
 * Scoped to the newest leaderboard snapshot by default, which matters once more than one
 * snapshot exists: taking the newest row per wallet across *all* snapshots keeps wallets that
 * have since dropped out of the leaderboard, and lets two wallets each claim `rank_position`
 * 1 from different snapshots — making "top 50" ill-defined and the ordering arbitrary. Older
 * entries stay in the table as history; they are simply not the current roster.
 */
export const listRosterWallets = (
  database: DatabaseSync,
  options: { chain?: string; limit?: number; allSnapshots?: boolean; snapshotId?: number } = {},
): RosterWallet[] => {
  const chain = options.chain ?? 'sol';
  // Plain positional `?` throughout: node:sqlite binds `all(...)` arguments by position, so
  // numbered `?N` placeholders raise "column index out of range". Both branches take the chain
  // twice, in the same order — outer filter first, subquery second.
  const latestSnapshotId = options.snapshotId ?? readLatestRankSnapshot(database).snapshotId;
  if (!options.allSnapshots && latestSnapshotId === null) return [];
  const scope = options.allSnapshots
    ? `id IN (SELECT MAX(id) FROM copytrade_wallets WHERE chain = ? GROUP BY wallet_address)`
    : `source_snapshot_id = ?`;
  const rows = database.prepare(
    `SELECT wallet_address AS walletAddress, chain, name, icon_url AS iconUrl, rank_position AS rankPosition,
            reported_pnl_30d AS reportedPnl30d, reported_winrate_30d AS reportedWinrate30d,
            risk_flags AS riskFlags
     FROM copytrade_wallets
     WHERE chain = ? AND ${scope}
     ORDER BY rank_position IS NULL, rank_position ASC, wallet_address ASC`,
  ).all(chain, options.allSnapshots ? chain : latestSnapshotId as number) as unknown as Array<Omit<RosterWallet, 'riskFlags'> & { riskFlags: string }>;

  const wallets = rows.map((row) => {
    // Unparseable flags mean "we do not know", and the safe reading of "we do not know" is
    // not "no risk". Returning an empty list here would let a wallet whose flags failed to
    // parse present as clean and become eligible for a positive verdict, so an explicit
    // unknown marker is returned instead — non-empty, so every risk gate still trips.
    let riskFlags: string[] = [UNKNOWN_RISK_FLAG];
    try {
      const parsed: unknown = JSON.parse(row.riskFlags);
      if (Array.isArray(parsed)) riskFlags = parsed.filter((flag): flag is string => typeof flag === 'string');
    } catch { /* keep the unknown marker */ }
    return { ...row, riskFlags };
  });
  return typeof options.limit === 'number' && options.limit > 0 ? wallets.slice(0, options.limit) : wallets;
};

/** Base58, Solana address alphabet only (excludes 0/O/I/l — those never appear in a real
 *  base58check-encoded key), 32-44 chars covers every real SOL wallet length seen in this
 *  project's own captured data. */
const SOL_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type SingleTraderLookup =
  | { kind: 'address'; walletAddress: string }
  | { kind: 'name_match'; walletAddress: string; matchedName: string }
  | { kind: 'not_found'; query: string };

/**
 * Resolves a single-trader search box input: a wallet address is used directly (no network
 * call needed — GMGN's own trade-history API takes an address, not a name). Anything else is
 * checked against names already captured from a real leaderboard snapshot
 * (`copytrade_wallets.name`, itself GMGN's `name ?? twitter_name` — see listRosterWallets'
 * source). Deliberately does NOT call out to GMGN to search for a name that isn't already
 * known here — this project has no verified GMGN name-search endpoint integrated yet, and
 * guessing one would risk querying the wrong route silently. A miss is reported as
 * 'not_found', not silently treated as an address.
 */
export const resolveSingleTrader = (
  database: DatabaseSync, query: string, chain = 'sol',
): SingleTraderLookup => {
  const trimmed = query.trim();
  if (SOL_ADDRESS_PATTERN.test(trimmed)) return { kind: 'address', walletAddress: trimmed };
  const row = database.prepare(
    `SELECT wallet_address AS walletAddress, name FROM copytrade_wallets
     WHERE chain = ? AND name IS NOT NULL AND LOWER(name) = LOWER(?)
     ORDER BY added_at DESC LIMIT 1`,
  ).get(chain, trimmed) as { walletAddress: string; name: string } | undefined;
  if (row) return { kind: 'name_match', walletAddress: row.walletAddress, matchedName: row.name };
  return { kind: 'not_found', query: trimmed };
};
