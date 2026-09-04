import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light';

const readThemeMode = (): ThemeMode => {
  try {
    return window.localStorage.getItem('vantage-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

/** Owns the application's theme preference and its DOM/storage side effects. */
export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    try {
      window.localStorage.setItem('vantage-theme', themeMode);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
  }, [themeMode]);

  const toggleTheme = useCallback(() => {
    setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'));
  }, []);

  return { themeMode, toggleTheme };
}
