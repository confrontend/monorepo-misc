import { UI_STRINGS } from '../strings.js';

type ThemeMode = 'dark' | 'light';

type AppHeaderProps = {
  themeMode: ThemeMode;
  onToggleTheme: () => void;
};

export function AppHeader({ themeMode, onToggleTheme }: AppHeaderProps) {
  return (
    <header className="hero">
      <div>
        <p className="eyebrow">GMGN / DUNE · BACKTEST</p>
        <h1>GMGN/Dune Backtest</h1>
        <p className="lede">
          Find promising Solana wallets by comparing GMGN performance with realistic delayed-copy
          backtests.
        </p>
      </div>
      <button
        type="button"
        className="theme-toggle"
        aria-pressed={themeMode === 'light'}
        onClick={onToggleTheme}
      >
        <span aria-hidden="true">{themeMode === 'dark' ? '☀' : '☾'}</span>
        {themeMode === 'dark' ? UI_STRINGS.header.themeLight : UI_STRINGS.header.themeDark}
      </button>
    </header>
  );
}
