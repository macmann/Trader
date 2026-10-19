# Phase 3 — advanced Spot trading development milestone

Phase 2 was merged through PR #2. This milestone adds multi-pair configuration, versioned strategies, portfolio accounting, risk-based sizing, and software protection controls. It does not complete the Phase 1 execution/reconciliation release requirements. Both trading switches must remain disabled.

## Available development paths

| Capability             | Current behavior                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pairs                  | BTCUSDT, ETHUSDT, SOLUSDT; Spot; USDT quote; 15-minute candles                                                                      |
| Multiple bots          | Independent tenant/bot configuration, positions, strategy versions, signals and AI histories                                        |
| Trend                  | Existing `trend-v1.0` behavior is preserved                                                                                         |
| Breakout               | `breakout-v1.0`: close above the preceding 20-candle high with volume above 150% of that window's average; exit below its low       |
| Risk sizing            | Fixed trade budget, or allocation × risk-per-trade percentage ÷ stop-loss percentage; capped by max trade and capital               |
| Software trailing stop | Persisted high-water mark; stop never loosens when price retraces                                                                   |
| Software break-even    | Activates from the persisted peak; cannot override a tighter trailing stop                                                          |
| Portfolio controls     | Workspace/connection/pair allocation and cost-exposure ceilings; distinct open/reserved bot-position limit                          |
| Limit entries          | Hypothetical planner only; starting these bots is rejected                                                                          |
| Bounded DCA            | `dca-v1.0` planner only: initial entry, price-step/interval checks and bounded entry count; no averaging down beyond bot allocation |
| Grid accumulation      | `grid-accumulation-v1.0` planner only: bounded accumulation rungs with aggregate profit exit; not a two-sided resting-order grid    |
| Derivatives            | Unsupported and rejected; no short selling, leverage, perpetuals, inverse contracts or options                                      |

The worker uses each bot's pair and strategy, per-pair public-feed freshness, and symbol-scoped account reconciliation checks. AI snapshots, cache keys, manual requests, and historical records carry the pair so changing a stopped flat bot cannot relabel historical AI analysis.

## Configure and preview

1. Create a connected Testnet bot with the desired pair and Trend/Breakout/DCA strategy. DCA is explicitly preview-only.
2. Open **Portfolio** to set total, per-connection and per-pair ceilings, and the open/reserved-position limit. The defaults are $1,000 for each allocation/exposure ceiling and five positions. These are examples, not recommended investment allocations.
3. Select a stopped, flat bot to edit capital, max trade, loss controls, pair, versioned strategy, sizing, trailing/break-even rules, or planner parameters. Configuration changes are rejected while a position or unresolved order exists. Strategy logic is not edited in place; the selected version is stored on each signal.
4. Use **Hypothetical planning** with a scenario price, available balance, quantity increment and minimum order value. The response is always `simulationOnly: true` and `orderSubmissionEnabled: false`. The planner does not call create-order APIs, reserve funds, persist fills, or advance DCA/grid inventory. It reads current tracked bot state; a new flat DCA bot therefore keeps previewing its first entry until that state changes through actual reconciliation.
5. Trend and Breakout need closed candles for entry signals. The simple preview form supplies no candle history and normally reports WAIT for flat bots. API callers can supply up to 100 hypothetical candles. This data is never treated as authoritative market data or used for execution.

A preview PASS covers its sizing, hypothetical exchange increments/minimums and allocation/exposure checks. It is not authorization to trade: it does not prove authenticated exchange connectivity, live market freshness, daily-loss correctness, AI permission, protective-order coverage, or execution readiness. Quantity/tick/minimum values entered into the preview are hypothetical, not verified exchange metadata.

## Portfolio accounting and reservations

Configuration allocations are accounting limits; funds remain at the exchange. Creation and configuration updates serialize on a workspace row lock so concurrent requests cannot exceed saved allocation ceilings. Portfolio settings use FORCE RLS and explicit tenant predicates. Unknown outstanding-order notional fails closed and prevents configuration changes.

Worker entry checks include tracked position cost and the full pending-buy reservation at workspace, connection and pair scope. Position counts deduplicate a held bot and its pending buy. Reservations are persisted on internal order intents before network submission and remain counted during uncertain outcomes. They release from the aggregate only when the order is known terminal; FAILED is deliberately not treated as terminal. Legacy pending orders lacking a notional require reconciliation rather than an invented estimate. Pending sells do not release existing position exposure before fills arrive.

Market buy quantities use the chosen trade budget, AI reduction where applicable, current ask, and a conservative 1% quantity-sizing buffer. The full budget is reserved. Exchange minimum/maximum quantities, minimum notionals, and increments are checked from instrument metadata before submission; missing required metadata rejects the signal. These controls do not replace the still-pending authoritative fee/balance/ledger work, and the buffer is not a guarantee against every execution cost.

The dashboard reports cost-basis exposure and pending reservations, not live marked-to-market equity. Per-pair limits combine the same pair across connections. Per-connection limits apply to each stored exchange connection; connecting the same underlying exchange account through multiple API-key records is not yet detected. Do not use duplicate connections for one account. Reconciliation completeness, daily P&L, true peak-equity drawdown, cross-account capital availability and full fee handling remain Phase 1 release requirements.

## Protection and lifecycle boundaries

Trailing and break-even calculations are deterministic software checks. High-water marks and entry metadata persist in PostgreSQL. Partial fills increment entry count once per buy order. Fills for different pairs update their own bot positions. A full tracked exit resets the high-water mark and entry count.

Stops require RUNNING status, a healthy worker, fresh per-pair public data, an authenticated private feed and successful reconciliation. Stop/pause still prevents execution and does not install exchange-native protection, cancel all exchange orders, or flatten a position. An outage or restart cannot reconstruct unobserved price peaks. Exchange-native stops, complete private event processing and tested recovery remain mandatory before enabling orders.

Limit, DCA and grid configuration is rejected at bot start and guarded again in the worker. Their production execution needs durable ladder/rung state, atomic reservations across layers, resting-order expiry/cancellation, fee-aware fills, and crash/retry/reconnect tests. No REST/worker flag bypass for these planners is provided.

## Setup and verification

Run `npm run setup` to apply migration `003-advanced-trading.sql`, refresh local runtime grants, and preserve existing private `.env` and encryption keys. Then run `npm test` and `npm run build`. Tests run in a temporary database that is removed afterward.

Coverage includes concurrent allocation creation, tenant-owned settings and configuration, preview non-execution, unknown pending reservations, risk-budget sizing, trailing/break-even monotonicity, strategy boundaries, instrument limits, mixed BTC/ETH fills, and partial-fill entry counting. Worker WebSockets use the inherited HTTPS proxy through a TLS-verified proxy agent; Node native fetch retains its environment-proxy flag.

Current-instance public Bybit instrument requests for all three pairs returned HTTP 403 (reported by the adapter as REGION_RESTRICTED). Authenticated Testnet trading and external pair availability are not verified. Exchange or regional restrictions must be surfaced, not bypassed. The supported local workflow remains code development, deterministic previews, and isolated tests until exchange access and the remaining Phase 1 execution checks are satisfied.
