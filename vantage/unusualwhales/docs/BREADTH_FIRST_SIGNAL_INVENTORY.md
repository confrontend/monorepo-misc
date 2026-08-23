# Breadth-first signal inventory

This inventory is the first comparison layer. Each source gets one simple event definition before any threshold optimization or subgroup discovery.

| Signal | Initial source | Simple event | Direction | Status | Main limitation |
|---|---|---|---|---|---|
| Call Sweep | `/api/option-trades` | intermarket sweep + call | bullish | Ready | provider delay |
| Put Sweep | `/api/option-trades` | intermarket sweep + put | bearish | Candidate | new importer required |
| Repeated Sweeps | option trades/alerts | 3 same-direction events in 30 minutes | signed | Candidate | grouping must be point-in-time |
| Dark Pool Block | `/api/darkpool/*` | non-canceled block above fixed floor | signed | Candidate | side/reporting lag |
| Call/Put Imbalance | market-tide/flow endpoint | signed premium imbalance | signed | Limited | endpoint/history verification |
| OI Spike | option contract historic | daily OI change | signed | Candidate | daily, contract-level history |
| GEX/Gamma | gamma endpoint | first published signed GEX observation | signed | Limited | point-in-time history unknown |
| Market/ETF Flow | market-tide/ETF endpoint | timestamped aggregate flow | signed | Limited | publication timing |
| Insider Activity | insider endpoint | first public filing | signed | Limited | filing lag and sparse data |
| Congress Activity | `/api/congress/*` | first public disclosure | signed | Limited | disclosure lag and small N |

All sources must feed the same normalized event and outcome framework. A source remains limited or blocked when its historical timestamp cannot be reconstructed without look-ahead.

