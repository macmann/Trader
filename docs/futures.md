# USDT perpetual futures — Testnet/Demo

Create a new bot and choose **Market → USDT perpetual · Long / Short**, **AI Strategy**, a configured model, and 15m/30m/1h candles. Existing Spot bots retain their market; converting a bot with historical Spot accounting is intentionally unavailable.

This release supports Bybit Global Testnet, Bybit EU Testnet (subject to exchange access), and OKX Demo USDT linear perpetuals for BTCUSDT, ETHUSDT and SOLUSDT. It is restricted to **isolated margin, 1× leverage, one-way/net position mode**, fixed trade sizing and AI Strategy. The exchange account must support the contract and have USDT collateral and the required derivatives API trading permission. Account-wide margin/position modes are checked, not changed automatically. Bybit requires its isolated-margin account mode; OKX orders explicitly use isolated margin. Per-symbol leverage is set to 1× only after flat-position and ownership checks.

## Decisions and execution

The selected model receives futures candles, calculated indicators, market type and the bot-owned position direction. BUY opens a long, SELL_SHORT opens a short, HOLD waits, and EXIT closes the current position. Opposite-direction recommendations never reverse an existing position automatically: close first, then evaluate a subsequent candle. Spot models cannot execute SELL_SHORT. Confidence thresholds, structured JSON validation, tenant usage quotas and provider budgets still apply.

Allocation and maximum trade values remain **full notional caps**, not leverage multipliers. One bot owns each contract on an exchange connection. Existing manual futures positions, unknown orders and position mismatches block execution; they are not adopted into the ledger. Do not trade the bot-owned contract manually or from other automation while it runs.

Entries use protected market execution: Bybit's native market slippage cap, or an OKX marketable IOC limit within 0.3% of the fresh quote. IOC orders can be partially filled or cancelled, so order placement does not imply a fill. Exits are reduce-only and bounded by the tracked position. An exchange acknowledgement loss is reconciled by client/exchange IDs; the worker does not blindly resend.

Hard stop-loss and take-profit checks run between AI candle evaluations; short protection and P&L use the opposite price direction from longs. A proximity check also requests an exit near the observed liquidation price. These are software controls requiring a running bot, private-feed readiness, a healthy worker/exchange and enabled execution; they do not guarantee an exit price or prevent liquidation during gaps/outages. Native exchange stop orders are not installed in this release. Pause/Stop cancel pending entries and do not liquidate open positions. Live execution remains disabled.

## Accounting and monitoring

Positions, orders and actual fills retain market type, entry/exit purpose and long/short direction. Short exits buy back contracts, rather than adding Spot inventory. Quantities shown internally and in the UI are base-asset equivalents; OKX contract counts are converted using instrument contract value and lot size. Exchange minimums may require a higher maximum trade value than a small Spot experiment; rejected decisions include proposed quantity and instrument limits.

Funding is reconciled as signed USDT cash events with tenant/bot-scoped idempotency. Bybit settlement `funding` and OKX funding `balChg` retain their signed cash direction. Realized position equity includes recorded fees and funding; closed trade-cycle statistics exclude funding and explicitly identify that limitation. Reconciliation checks open orders, fills, funding and exchange position quantity/direction/entry price before allowing further execution. Long/short notional exposure and entry reservations share the existing workspace/connection/symbol risk limits.

Use the bot monitor for direction, P&L, funding, software protection, liquidation-price observations, AI decisions, fills and order states. **Diagnostics & export** includes funding events and contract decisions. Unrecognized liquidation/ADL activity or unsupported fee/rebate types lock execution for investigation rather than silently rewriting the financial ledger.

## Deployment and validation

Migration 013 adds market/purpose/direction metadata and the funding ledger, preserving existing Spot records. No new environment variables are required. Configure AI credentials in Admin Settings as before.

Automated tests use isolated PostgreSQL and simulated exchange/provider responses. Before unattended use, verify the actual Demo/Testnet account's permissions, isolated/net mode, contract sizes, fill/cancellation behavior, funding, reconnect/restart recovery and reduce-only exits. Authenticated external futures acceptance has not been performed in this development environment. Historical futures backtesting, hedge-mode portfolios, leverage above 1× and live futures are not part of this release.
