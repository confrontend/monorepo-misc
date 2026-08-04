# Seeking Alpha Research Ideas

This document captures an early-stage product brainstorm. It is intentionally focused on problem framing, possible architecture, and questions to resolve before implementation.

## Idea 1: Chrome extension for historical quant-prediction backtesting

Build a Chrome extension that runs on Seeking Alpha pages and helps collect historical stock-prediction data exposed by the site’s Quant Ratings or related prediction views.

### Possible workflow

1. The user opens a supported Seeking Alpha stock page.
2. The extension detects the relevant prediction and rating data visible to the user.
3. The user chooses a stock, date range, prediction type, and export format.
4. The extension saves normalized observations locally and optionally exports CSV or JSON.
5. A local web UI displays historical predictions, realized outcomes, and backtest results.

### Backtesting questions

- What exactly is the prediction target: return, rating change, price direction, or an investability signal?
- What is the forecast horizon: 1 week, 1 month, 3 months, 6 months, or 1 year?
- How should “success” be defined: absolute return, benchmark-relative return, hit rate, ranking quality, or risk-adjusted return?
- Can we reconstruct point-in-time predictions without accidentally using revised or survivorship-biased data?
- How should delisted stocks, ticker changes, splits, dividends, missing observations, and stale predictions be handled?
- Which benchmark and transaction-cost assumptions should be used?

### Extension design ideas

- React + TypeScript for the popup and options pages.
- A content script for page-level extraction, with a background service worker coordinating storage and exports.
- A versioned extractor per page/data layout so site changes are easier to detect and maintain.
- Local-first storage using IndexedDB in the browser, with an optional sync path to the local backend.
- Clear provenance for every observation: source URL, capture timestamp, page type, extractor version, and raw payload where permitted.
- A manual capture mode as a fallback when automatic extraction is unavailable.

## Idea 2: Gmail-driven monitoring and estimation

Because there may not be a public Seeking Alpha API, use email as a source of signals. The system could monitor Seeking Alpha emails for selected people, articles, authors, alerts, or stocks, then run local estimation or analysis against the incoming messages.

### Possible workflow

1. The user defines subscriptions or Gmail search rules, such as an author, ticker, article category, or alert type.
2. Gmail messages are retrieved locally using a narrowly scoped Gmail integration.
3. The system parses message metadata and content into normalized events.
4. A local estimation pipeline evaluates the event against historical prices, ratings, or prior predictions.
5. The UI shows the event, extracted entities, estimated outcome, confidence, and links back to the original email.

### Gmail integration options

- Preferred: Gmail API with OAuth and read-only scopes.
- Local development: poll Gmail on demand or on a local schedule, storing only the minimum required metadata and parsed fields.
- Alternative: Gmail filters/labels to make the monitored message set explicit and reduce accidental collection.
- Avoid relying on brittle inbox scraping; treat email formats as versioned inputs and retain parsing diagnostics.

### Estimation ideas

- Classify whether an email represents a new thesis, rating change, earnings commentary, price target, or news item.
- Extract tickers, authors, article identifiers, timestamps, rating language, and directional signals.
- Compare the signal with subsequent price and benchmark performance over configurable horizons.
- Track precision, recall, hit rate, average excess return, drawdown, and calibration over time.
- Separate discovery from evaluation so the system does not use future information when scoring a historical signal.

## Shared product concept

The two ideas can converge on one local research workspace:

```text
Chrome extension + Gmail connector
                |
                v
       Local ingestion service
                |
                v
  Normalized events and observations
                |
                v
     Backtesting / estimation engine
                |
                v
       React + TypeScript dashboard
```

### Recommended initial stack

- Frontend: React + TypeScript, likely Vite, with a small dashboard for imports, datasets, experiments, and results.
- Browser integration: Chrome Manifest V3, TypeScript, content scripts, background service worker, and IndexedDB.
- Backend: Python FastAPI. It is a good fit for data ingestion, parsing, statistical experiments, and a clean local HTTP API.
- Storage: SQLite for the first local version, with SQLAlchemy or SQLModel and migrations. Keep repositories portable so PostgreSQL can be used later.
- Jobs: a simple local scheduler or explicit “Run now” actions initially; move to a queue/worker system only when needed.
- Analysis: Python data tooling, with reproducible experiment configurations and stored result summaries.
- Packaging: separate frontend, extension, and backend processes during development; add a single local launcher later if useful.

### Local-first, cloud-ready boundaries

- Keep the browser extension, Gmail connector, API, analysis engine, and persistence layer as separate modules.
- Use environment-based configuration for URLs, credentials, storage, and job schedules.
- Make ingestion idempotent using stable source identifiers and content hashes.
- Store timestamps in UTC and preserve source timestamps separately.
- Keep provider-specific code behind interfaces so Gmail or a future data source can be replaced.
- Make long-running analysis jobs callable through an API, even when they execute in-process locally.
- Do not require a cloud service for the core workflow; cloud deployment should be an operational choice later.

## Risks and constraints to investigate

- Seeking Alpha page structure, access controls, terms of service, and whether automated extraction or storage is permitted.
- Gmail OAuth scope, consent, token storage, message retention, and handling of sensitive email content.
- Whether the historical prediction data is actually available in a stable, point-in-time form.
- Reproducibility: captured data should be distinguishable from data reconstructed later.
- Financial-risk boundary: results are research/backtesting outputs, not investment advice.
- Rate limits, account restrictions, CAPTCHA, login walls, and site layout changes.

## Suggested discovery milestones

1. Manually identify one supported Seeking Alpha page and document the exact fields available.
2. Capture a small, user-initiated sample and define a normalized observation schema.
3. Decide whether the first backtest is a simple directional metric or a benchmark-relative return study.
4. Identify representative Seeking Alpha emails and define a minimal Gmail label/search strategy.
5. Test extraction and estimation on a small local fixture dataset before connecting live sources.
6. Build the dashboard around provenance, experiment configuration, and result interpretation rather than only charts.

## Open questions

- Which Seeking Alpha prediction product and page types are in scope first?
- Is the goal personal research, a reusable tool, or a team application?
- What data retention and privacy policy should apply to captured pages and Gmail messages?
- Which stocks, authors, alerts, and forecast horizons matter most?
- Should extension-captured data remain browser-local, or be pushed to the local backend by default?
- What would count as a useful first result: a dataset export, a backtest report, or a live monitoring dashboard?
