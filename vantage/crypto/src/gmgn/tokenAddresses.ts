import type { DatabaseSync } from 'node:sqlite';

export interface GmgnTokenAddressSummary {
  addresses: string[];
  total: number;
  matchedToCohort: number;
  unmatchedToCohort: number;
}

/**
 * Unique token addresses GMGN has observed a signal for, split by whether the address already
 * exists in the imported Dune cohort — the unmatched ones are exactly what a targeted Dune
 * lookup should be run against, instead of re-requesting addresses already on file.
 */
export const listGmgnTokenAddresses = (database: DatabaseSync): GmgnTokenAddressSummary => {
  const rows = database
    .prepare(
      `
    SELECT DISTINCT s.token_address AS tokenAddress
    FROM gmgn_signals s
    WHERE s.token_address IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.token_address = s.token_address)
    ORDER BY s.token_address
  `,
    )
    .all() as unknown as { tokenAddress: string }[];

  const totals = database
    .prepare(
      `
    SELECT
      COUNT(DISTINCT token_address) AS total,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM tokens t WHERE t.token_address = s.token_address) THEN token_address END) AS matched
    FROM gmgn_signals s WHERE s.token_address IS NOT NULL
  `,
    )
    .get() as { total: number; matched: number };

  return {
    addresses: rows.map((row) => row.tokenAddress),
    total: totals.total ?? 0,
    matchedToCohort: totals.matched ?? 0,
    unmatchedToCohort: rows.length,
  };
};
