// Chronological holdout splitting — generic over any dated observation, no database dependency.
// "Discover" a candidate on the earlier slice, "test" it on the later slice; never select and
// evaluate a rule using the same data. Deliberately dumb (a single date cutoff, not k-fold or
// anything fancier) — the whole point is that the split boundary is obvious and can't be tuned
// after seeing results.

export type DatedObservation = { observedAt: string };
export type HoldoutSplit<T> = { discovery: T[]; test: T[]; splitDate: string; discoveryDates: number; testDates: number };

const dateOnly = (isoTimestamp: string): string => isoTimestamp.slice(0, 10);

export const splitByDate = <T extends DatedObservation>(observations: T[], splitDateIso: string): HoldoutSplit<T> => {
  const discovery = observations.filter((o) => o.observedAt < splitDateIso);
  const test = observations.filter((o) => o.observedAt >= splitDateIso);
  return {
    discovery,
    test,
    splitDate: splitDateIso,
    discoveryDates: new Set(discovery.map((o) => dateOnly(o.observedAt))).size,
    testDates: new Set(test.map((o) => dateOnly(o.observedAt))).size,
  };
};

/**
 * Picks a split date from the distinct calendar dates actually present in the data, not a
 * fixed clock-time fraction — a dataset with uneven daily volume would otherwise get a lopsided
 * split. Returns null when there are fewer than 2 distinct dates, since no chronological split
 * is meaningful with only one day of data (this is the common case right now; callers should
 * treat holdout results as "not yet available," not silently skip validation).
 */
export const suggestSplitDate = (observations: DatedObservation[], testFraction = 0.3): string | null => {
  if (!observations.length) return null;
  const dates = [...new Set(observations.map((o) => dateOnly(o.observedAt)))].sort();
  if (dates.length < 2) return null;
  const clampedFraction = Math.min(0.9, Math.max(0.1, testFraction));
  const splitIndex = Math.min(dates.length - 1, Math.max(1, Math.round(dates.length * (1 - clampedFraction))));
  return `${dates[splitIndex]}T00:00:00.000Z`;
};
