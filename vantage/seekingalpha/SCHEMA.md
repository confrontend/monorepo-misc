# Quant Rating History — Extraction Schema

This defines the data contract for the Chrome extension's collection target: Seeking Alpha's Quant Rating History table and surrounding page context. The extension only collects and exports data; backtesting and analysis happen in a separate tool.

## Feasibility

Confirmed feasible: the extension can read the rendered DOM, collect the history table rows, and export them as JSON. No network interception or API access is required.

## Reference sample

Captured from a Seeking Alpha symbol page (MU / Micron Technology):

- Ticker: `MU`, Company: `Micron Technology, Inc.`
- Exchange: `NASDAQ`, Currency: `USD`
- Current price: `$834.56`, change: `+11.53 (+1.40%)`
- Current Quant Rating: `Strong Buy`, Quant Score: `4.99`
- Quant history chart supports `1M`, `6M`, `1Y`, `3Y` ranges; sample chart had 255 price/rating points spanning 2025-07-29 through 2026-08-03
- Historical table columns: `Date | Price | Quant Rating | Quant Score | Valuation | Growth | Profitability | Momentum | EPS Rev.`
- Sample table contained 116 rows

Example rows:

```
08/03/2026 | 834.56 | Strong Buy | 4.99 | A  | A+ | A+ | A+ | A
07/31/2026 | 823.03 | Strong Buy | 4.99 | A- | A+ | A+ | A+ | A+
07/30/2026 | 874.66 | Strong Buy | 4.99 | A- | A+ | A+ | A+ | B
07/29/2026 | 739.00 | Strong Buy | 4.99 | A  | A+ | A+ | A+ | A-
```

## Extraction target

```
Ticker identity
        +
Point-in-time Quant Rating History
        +
All factor columns
        +
Capture/provenance metadata
```

## JSON record shape

```json
{
  "ticker": "MU",
  "companyName": "Micron Technology, Inc.",
  "exchange": "NASDAQ",
  "currency": "USD",
  "sourceUrl": "https://seekingalpha.com/symbol/MU/ratings/quant-ratings",
  "capturedAt": "2026-08-03T21:03:00Z",
  "pageIntervalSelected": "1Y",
  "extractorVersion": "1.0.0",
  "morerowsAvailable": false,
  "paginationState": {
    "loadedRows": 116,
    "totalRowsKnown": null,
    "loadMoreControlPresent": true,
    "loadMoreClicked": false
  },
  "currentSnapshot": {
    "price": 834.56,
    "priceChangeAbsolute": 11.53,
    "priceChangePercent": 1.40,
    "quantRating": "Strong Buy",
    "quantScore": 4.99
  },
  "history": [
    {
      "date": "2026-07-29",
      "price": 739.00,
      "quantRating": "Strong Buy",
      "quantScore": 4.99,
      "valuation": "A",
      "growth": "A+",
      "profitability": "A+",
      "momentum": "A+",
      "epsRevisions": "A-",
      "rawRowText": "07/29/2026 | 739.00 | Strong Buy | 4.99 | A | A+ | A+ | A+ | A-"
    }
  ]
}
```

### Field notes

- `pageIntervalSelected` — which chart range (`1M`/`6M`/`1Y`/`3Y`) was active at capture time; the history table's row count and date span can depend on this.
- `extractorVersion` — versioned per the README's "versioned extractor per page/data layout" design goal, so page/layout changes are detectable.
- `paginationState` — whether the full available history was loaded, or more rows exist behind a "load more" control. Needed so a partial capture isn't mistaken for a complete one.
- `rawRowText` — the raw displayed row content, kept alongside parsed fields for provenance and to make schema drift or mis-parsing detectable later.
- `history[].price` — see limitation below; this is whatever value Seeking Alpha displays in the table, not confirmed to be close/adjusted/intraday.

## Known limitations

- The table does not establish whether each historical price is a closing price, an adjusted price, or an intraday value. This should be resolved (e.g., by cross-checking against a known market-data source) before it's used in return calculations.
- The most recent signal in any capture cannot be evaluated until enough future trading days have elapsed (a working assumption of 7 trading days was used for the minimal backtest sketch below, but the actual horizon is an open design choice — see README's "Backtesting questions").
- Future/outcome prices are not present in this data at all. They must come from a separate historical market-data source, or from later captures of the same ticker over time.

## Minimal backtest visualization (for context only — not implemented in the extension)

```
Signal date       Signal                         Future outcome

2026-07-29        Strong Buy, score 4.99         ───────►
                  price: $739.00                         N trading days later:
                                                          future price
                                                          return: calculated later

2026-07-30        Strong Buy, score 4.99         ───────►
                  price: $874.66                         N trading days later:
                                                          future price
                                                          return: calculated later
```

This confirms the shape of data the analysis engine will eventually need, but the analysis engine itself stays outside the Chrome extension, per the README's local-first, cloud-ready module boundaries.

## Still open

- Confirm price basis (close vs. adjusted vs. intraday) against a reference source.
- Decide the backtest evaluation horizon(s) — the "N trading days" above is a placeholder.
- Decide how repeated captures of the same ticker/date are reconciled (idempotency key candidate: `ticker` + `date` + `sourceUrl`, per the README's "stable source identifiers and content hashes" principle).
