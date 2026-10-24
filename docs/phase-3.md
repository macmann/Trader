# Phase 3 — advanced Spot trading

Phase 3 adds executable multi-pair strategies, portfolio controls and durable order lifecycle handling. This remains a development Testnet implementation. Live connections are rejected and both execution switches remain disabled by default. Simulated integration tests do not replace authenticated exchange acceptance.

## Strategies and configuration

Supported pairs are BTCUSDT, ETHUSDT and SOLUSDT, Spot only, with 15-minute candles. Multiple bots retain independent allocations, positions, signals and versioned strategy history. Derivatives, leverage and short selling are rejected.

- `trend-v1.0` retains its original EMA/RSI/volume behavior.
- `breakout-v1.0` requires range and volume confirmation.
- `dca-v1.0` executes bounded layers with price-step, interval, entry-count and total-capital checks.
- `grid-accumulation-v1.0` preserves the original accumulation rules. New `grid-accumulation-v1.1` requires a pullback before reentering after a completed cycle. Both track consumed rungs durably and exit the aggregate position; neither is a two-sided market-making grid.

Market and Limit entries are supported. Limit orders persist rounded price, GTC/PostOnly policy and configurable expiry. Only one unresolved order per bot progresses at a time. Fixed-budget or stop-distance risk sizing is capped by max trade, remaining allocation and portfolio limits. Software trailing stops and break-even levels use a persisted high-water mark and never loosen an existing tighter stop.

Configure stopped, flat bots in the dashboard. Configuration changes are rejected while positions or unresolved orders exist. Portfolio settings cap allocation and cost exposure across the workspace, connection and pair, including pending reservations and distinct held/reserved bot positions. Allocation is an accounting limit; funds remain at the exchange.

The hypothetical planner stays separate from execution: it always returns `simulationOnly: true` and `orderSubmissionEnabled: false`, uses hypothetical instrument inputs, and cannot create orders or advance ladder state.

## Execution and recovery

The worker reconciles before evaluating, applies strategy/AI/risk checks, persists the full order intent and reservation, then rechecks execution controls before submission. A committed attempted-send marker precedes network I/O. Bybit `orderLinkId` identifies each intent. An unsent intent can recover after restart; attempted or ambiguous requests are reconciled rather than blindly resubmitted. Unknown outcomes retain reservations and lock trading.

Workspace and bot locks serialize concurrent workers. Grid rung/cycle uniqueness also has a database constraint. Every order stores its strategy version; append-only order events record lifecycle transitions. Fills deduplicate by tenant and exchange execution ID, including partial fills and quote/base-asset fees. Unsupported fee currencies fail closed. Entry count advances once per filled buy order. A flat exit records a net closed-cycle result and resets ladder state.

Resting entries are cancelled when stopped, expired, globally disabled, or superseded by a protective exit. Cancellation requests and uncertain responses retain reservations until exchange reconciliation proves terminal status and all reported fills have arrived. A terminal order with missing executions stays RECONCILING. Protective exits wait for entry cancellation/fill reconciliation before selling tracked inventory.

Reconciliation pages open orders and execution history with cursor-loop detection. It uses overlapping, bounded seven-day history; longer unresolved downtime locks execution for review. Unexpected exchange orders or account inventory discrepancies also lock trading. Migration 004 marks connections with legacy execution records as ledger version 1 and risk-locks their bots: these require an operator-verified ledger rebuild against exchange history before use. Merely changing the version flag is unsafe.

## Risk and operating boundaries

New entries include tracked position cost and complete pending-buy reservations in all portfolio limits. Unknown notional fails closed. Final dispatch checks available quote balance, reservations, current market-buy budget, bot/global state, freshness, private-stream readiness and AI Filter validity. Fees reduce tracked net inventory and performance. Consecutive-loss limits use closed-cycle results; drawdown uses the persisted observed equity peak. Daily loss uses today's fill results plus negative current unrealized P&L, a conservative approximation rather than a midnight equity ledger.

Stop cancels pending entries but does not liquidate inventory. Pause blocks new entries while retaining software risk exits. Stopped bots do not maintain protective exits. Software protection requires a healthy worker, fresh market data, private-feed readiness and successful reconciliation. It is not exchange-native protection and cannot reconstruct peaks missed during an outage. Complete event-driven private-stream processing and exchange-native protection remain production release requirements.

Duplicate connection records for the same underlying exchange account are not detected. Use dedicated accounts and avoid duplicate connections. Live trading, production email delivery, deployment operations and production acceptance remain outside this tested development release.

## Validation and setup

Run `npm run setup` to apply checksum-verified migrations through `004-execution-lifecycle.sql` and refresh restricted database grants without replacing private encryption keys. Run `npm test`, `npm run build` and `npm audit --omit=dev --audit-level=high`.

Tests use an isolated PostgreSQL database and a simulated exchange. They exercise actual worker dispatch, bounded DCA, fee-aware fills, limit price/TIF/expiry, uncertain cancellation, grid cycles, concurrent workers, fault recovery before/after attempted submission, lost acknowledgements, stops, freshness gates, pagination and missing-fill reconciliation, alongside authentication, tenant isolation, AI and portfolio tests. No external orders are placed.

This cloud instance previously received HTTP 403 from public Bybit instrument endpoints. Authenticated Testnet trading and pair availability remain unverified; restrictions must be surfaced rather than bypassed. Keep Testnet execution Off in Admin Settings and `LIVE_TRADING_PLATFORM_ENABLED=false` until external acceptance and the remaining production prerequisites are satisfied.
