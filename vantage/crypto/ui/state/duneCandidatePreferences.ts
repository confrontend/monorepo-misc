export type DuneCandidateFilters = {
  potentialOnly: boolean;
  hideNonPositivePnl: boolean;
  minimumScore: string;
};

const SELECTION_STORAGE_KEY = 'copytrade:dune-candidate-selection:v1';
const FILTER_STORAGE_KEY = 'copytrade:dune-candidate-filters:v1';

const defaultFilters = (): DuneCandidateFilters => ({
  potentialOnly: true,
  hideNonPositivePnl: true,
  minimumScore: '',
});

export const loadDuneCandidateSelection = (): Set<string> => {
  if (typeof window === 'undefined') return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(SELECTION_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(value)
      ? new Set(value.filter((item): item is string => typeof item === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
};

export const saveDuneCandidateSelection = (selection: Set<string>): void => {
  window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify([...selection]));
};

export const loadDuneCandidateFilters = (): DuneCandidateFilters => {
  if (typeof window === 'undefined') return defaultFilters();
  try {
    const value = JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return {
      potentialOnly: value.potentialOnly !== false,
      hideNonPositivePnl: value.hideNonPositivePnl !== false,
      minimumScore: typeof value.minimumScore === 'string' ? value.minimumScore : '',
    };
  } catch {
    return defaultFilters();
  }
};

export const saveDuneCandidateFilters = (filters: DuneCandidateFilters): void => {
  window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
};
