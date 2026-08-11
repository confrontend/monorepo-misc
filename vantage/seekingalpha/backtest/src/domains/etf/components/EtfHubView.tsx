import type { ResearchJob, ResearchReport } from '../../../api';
import type { SignalDiscoveryResult } from '../../../data';
import { EtfCheckView } from '../../etf-check/components/EtfCheckView';
import { PortfolioTrackerView } from '../../portfolio-tracker/components/PortfolioTrackerView';
import { ResearchView } from '../../research/components/ResearchView';
import { SignalDiscoveryView } from '../../signal-discovery/components/SignalDiscoveryView';

export function EtfHubView({
  section,
  discovery,
  researchReport,
  researchJob,
  onRunDiscovery,
  onRunResearch,
  onExportResearch,
}: {
  section: 'all' | 'discovery' | 'candidates' | 'research' | 'portfolios';
  discovery: SignalDiscoveryResult | null;
  researchReport: ResearchReport | null;
  researchJob: ResearchJob | null;
  onRunDiscovery: () => void;
  onRunResearch: () => void;
  onExportResearch: () => void;
}) {
  return (
    <main className="etf-workspace">
      <section className="etf-workspace-intro">
        <div className="eyebrow">One ETF workflow</div>
        <h2>{section === 'discovery' ? 'Discover and validate ETF rules' : section === 'candidates' ? 'Current ETF candidates' : section === 'research' ? 'Statistical evidence and diagnostics' : section === 'portfolios' ? 'Build and track real portfolios' : 'Discover the rule, then find today&apos;s matches'}</h2>
        <p>
          {section === 'discovery'
            ? 'Find patterns in historical ETF ratings, then test the rule on an unseen period.'
            : section === 'candidates'
              ? 'See which imported ETFs currently match a rule that already passed the validation gate.'
              : section === 'research'
                ? 'Inspect SPY comparisons, placebo tests, bootstrap results, and the methodology behind the ETF conclusions.'
                : section === 'portfolios'
                  ? 'Check out a confirmed rule as a real portfolio, then paste Seeking Alpha snapshots to track it over time.'
                  : 'The first section learns and validates rating rules. The second finds current matches. The third shows the detailed evidence.'}
        </p>
      </section>

      {(section === 'all' || section === 'discovery') && <details className="etf-workspace-section" open>
        <summary><strong>1. Discover and validate ETF rules</strong><span>Find patterns in the data and test them on the unseen period</span></summary>
        <SignalDiscoveryView result={discovery} onRun={onRunDiscovery} universe="etf" showResearchLink={false} />
      </details>}

      {(section === 'all' || section === 'candidates') && <details className="etf-workspace-section" open>
        <summary><strong>2. Current ETF candidates</strong><span>See which imported ETFs currently match a validated rule</span></summary>
        <EtfCheckView showAllOnLoad />
      </details>}

      {(section === 'all' || section === 'research') && <details className="etf-workspace-section" open={section === 'research'}>
        <summary><strong>3. Statistical evidence and diagnostics</strong><span>Inspect SPY comparisons, placebo tests, bootstrap results, and methodology</span></summary>
        <ResearchView
          report={researchReport}
          job={researchJob}
          onRun={onRunResearch}
          onExportResults={onExportResearch}
          scope="etf"
        />
      </details>}

      {(section === 'all' || section === 'portfolios') && <details className="etf-workspace-section" open={section === 'portfolios'}>
        <summary><strong>4. Build and track real portfolios</strong><span>Check out a confirmed rule, then track it against Seeking Alpha snapshots</span></summary>
        <PortfolioTrackerView />
      </details>}
    </main>
  );
}
