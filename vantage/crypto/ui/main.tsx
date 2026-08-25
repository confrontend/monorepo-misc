import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { App } from './App.js';

// Every Vite HMR update to this module re-runs this file's top level. Calling createRoot() again
// each time mounted a second React tree onto the same #root element without disposing the first
// — React's own console warning ("createRoot() on a container that has already been passed to
// createRoot() before") was firing on every single edit all session. Whichever root won the race
// could keep rendering stale content indefinitely after that, even though the served source and
// the API data were both already current — a real bug, not a caching illusion. Stashing the root
// on `window` and reusing it across hot reloads is the fix React's own docs recommend for this
// exact warning.
declare global {
  interface Window {
    __copytradeReactRoot?: ReturnType<typeof createRoot>;
    __copytradeQueryClient?: QueryClient;
  }
}
const rootContainer = document.getElementById('root')!;
if (!window.__copytradeReactRoot) window.__copytradeReactRoot = createRoot(rootContainer);
// This app reads fresh from SQLite on explicit user action and never silently refetches behind
// the user's back (see progress.md history on browser-side report/data caches). Queries must
// not surprise-refetch on window focus, and the manual fetches this replaces never retried.
// Stashed on `window` for the same reason as the React root above: HMR re-runs this module's
// top level on every edit, and a fresh QueryClient each time would drop the query cache.
if (!window.__copytradeQueryClient)
  window.__copytradeQueryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  });
window.__copytradeReactRoot.render(
  <QueryClientProvider client={window.__copytradeQueryClient}>
    <App />
  </QueryClientProvider>,
);
