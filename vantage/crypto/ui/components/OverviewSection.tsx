import { formatTime } from '../httpClient.js';
import type { GmgnStatus, Stats } from '../types.js';

type OverviewSectionProps = {
  stats: Stats;
  gmgnStatus: GmgnStatus | null;
};

export function OverviewSection({ stats, gmgnStatus }: OverviewSectionProps) {
  return (
    <section id="overview" className="menu-section">
      <ol className="workflow-strip">
        <li className={stats.tokenCount > 0 ? 'done' : 'active'}>
          <span>1</span>
          <div>
            <strong>Import a Dune cohort</strong>
            <small>
              {stats.tokenCount > 0
                ? `${stats.tokenCount.toLocaleString()} tokens stored`
                : 'Not started'}
            </small>
          </div>
        </li>
        <li
          className={gmgnStatus?.configured ? (stats.gmgnSignalCount > 0 ? 'done' : 'active') : ''}
        >
          <span>2</span>
          <div>
            <strong>Capture GMGN signals</strong>
            <small>
              {stats.gmgnSignalCount > 0
                ? `${stats.gmgnSignalCount.toLocaleString()} signals captured`
                : 'Import a browser export, fetch once, or start watching'}
            </small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>Review evidence &amp; diagnostics</strong>
            <small>Archives, coverage, activity, and logs below</small>
          </div>
        </li>
      </ol>
      <section className="stats-grid">
        <article className="stat-card">
          <span>Tokens</span>
          <strong>{stats.tokenCount.toLocaleString()}</strong>
          <small>unique addresses</small>
        </article>
        <article className="stat-card">
          <span>GMGN signals</span>
          <strong>{stats.gmgnSignalCount.toLocaleString()}</strong>
          <small>raw observations</small>
        </article>
        <article className="stat-card">
          <span>First trade range</span>
          <strong>{formatTime(stats.tokenFirstTrade.earliest)}</strong>
          <small>to {formatTime(stats.tokenFirstTrade.latest)}</small>
        </article>
        <article className="stat-card">
          <span>Observed range</span>
          <strong>{formatTime(stats.gmgnObserved.earliest)}</strong>
          <small>to {formatTime(stats.gmgnObserved.latest)}</small>
        </article>
      </section>
    </section>
  );
}
