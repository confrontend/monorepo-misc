import { useCallback, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export function useSortState<K extends string>(defaultKey: K, defaultDirection: SortDirection = 'asc') {
  const [sort, setSort] = useState<{ key: K; direction: SortDirection }>({ key: defaultKey, direction: defaultDirection });

  const toggleSort = useCallback((key: K) => {
    setSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  }, []);

  const sortIndicator = useCallback(
    (key: K) => (sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''),
    [sort],
  );

  return { sort, setSort, toggleSort, sortIndicator };
}
