# Bot monitoring and trading history

Open **Bots → View monitor** on any bot. A successful Start request also opens its monitor automatically. The panel polls persisted data every five seconds; it does not issue new exchange orders or authenticated exchange reads just because a user opens it.

## What is shown

- **Current state:** recorded bot status, pending action, exchange connection, Testnet execution setting, emergency stop and active blockers. RUNNING is a state, not proof of fresh market data or a healthy worker.
- **Worker observations:** last check, last completed check, reconciliation result, private subscription readiness, market timestamp, last observed mark, worker stage and retained failure code. Unknown/stale observations are labelled explicitly. A stale mark produces unavailable unrealized P&L/equity instead of a fabricated value.
- **Current exposure:** bot-attributed Spot quantity, cost basis, average entry, last mark, fees, realized net cash P&L and estimated equity. These are ledger-derived values, not the entire exchange wallet. Software protection levels are shown only when computed by a worker; they are not evidence of exchange-native stop orders.
- **Open/unresolved orders:** pending intents, submission uncertainty, open and partially filled orders. Order placement is not a fill. Uncertain states remain visible rather than disappearing from exposure.
- **Entries/exits:** individual reconciled fills, including partial fills, buy/sell direction, quantity, execution price, fee and realized exit P&L, linked to their order and run.
- **Closed trades:** fully closed position cycles with stored net P&L and strategy version. Fill counts, filled-order counts and closed cycles are different measures.
- **Signals and risk:** strategy direction/reasons and recorded approval/rejection, including signals that produced no order. AI decisions have their own history tab.
- **Activity and order events:** bot lifecycle records, safe failure diagnostics and order transitions. Raw exchange payloads, credentials and secrets are excluded.
- **Runs and configuration:** tracked Start-to-Stop runs, base risk limits and versioned strategy settings. Base performance cards are lifetime totals; selecting a run filters supported history lists, not lifetime/open-position metrics.

All history lists have keyset pagination and **Load older records**. Opening a monitor does not silently limit the available history to the latest handful of fills. First-page lists refresh while being viewed; after older pages are loaded, use **Refresh history** to return to the newest records. Activity and AI history are lifetime records and do not support run filtering. The run list can inspect older runs directly even beyond the recent-run dropdown.

## Start, pause and stop

Start is disabled while STARTING or RUNNING; Pause is available only while STARTING/RUNNING, and Stop is disabled when already STOPPED. Pending actions disable controls immediately, with an immediate client lock preventing duplicate clicks before React renders. Viewers have read-only controls.

The API also enforces transitions under portfolio/bot locks. Repeated Start on STARTING/RUNNING returns the current state without resetting it, duplicating audit events or opening another run. Pause/resume and retries after a risk lock retain the same open run until Stop. Stop All closes the tenant's open runs atomically with bot state changes. A new Start after Stop creates a new tracked run.

Stop/Pause do not liquidate positions. They block new entries and request cancellation of resting entries through the worker. Reconciliation continues, so fills can arrive after Stop. A late fill remains associated with the run of its order, not a newly started run. A position may span runs; closed-cycle run filtering follows its closing order. Software exits also require a healthy active worker/exchange and enabled execution; turning execution Off does not close a position or undo a sent order.

## Risk locks and diagnosing no trades

The panel separates blockers such as execution Off, emergency stop, stale/unknown worker checks, missing private subscriptions, stale market data, waiting for a closed candle and reconciliation failure. A failure such as `UNEXPECTED_ACCOUNT_POSITION` explains that exchange holdings differ from the tracked bot ledger; do not reset the ledger or repeatedly press Start to hide a mismatch.

Historical failures recorded before this feature may contain only `RECONCILIATION_FAILED`; the original detailed cause cannot be reconstructed. After checking the connection and history, a deliberate **Retry start checks** triggers fresh checks and records safe diagnostics. Unknown exception details are redacted; sanitized worker logs retain the error type. API keys, secrets and arbitrary exception messages are never included in monitoring.

## Data and deployment

Migration `008_bot_monitoring.sql` adds tenant-scoped RLS-protected runs and worker observations, plus optional order/signal run links and history indexes. It preserves old bots, orders, fills and accounting. Active legacy bots receive a `MONITORING_ADOPTED` tracking marker with the migration timestamp; this is not their original start time. Existing orders/fills retain unknown run attribution and remain visible in **All runs, including legacy history**.

Worker observations are persisted separately from financial transactions. Monitoring write failures do not roll back trading/accounting operations. Worker error codes are retained across idle risk-locked checks and cleared by a later successful active evaluation. Monitoring does not remove or bypass risk, idempotency, tenant isolation, execution permission or Live trading controls.

Deploy web and worker together through the existing Compose migration flow. No new environment variables are required. Real exchange acceptance, market/account connectivity and exchange-native protection remain independent operator checks. Local fixtures and browser tests do not demonstrate profitability or certify live trading.

### Prefunded accounts

Migration 009 adds a tenant-scoped inventory baseline. On the first successful reconciliation of a fresh connection with no submitted orders or recorded bot fills, current base-asset holdings are saved as non-bot inventory. Existing exchange fills dated before that enrollment are excluded from bot history; unknown open orders still block enrollment. The baseline is immutable to the application role and persists across restarts.

The monitor's Account inventory isolation panel separates non-bot holdings, aggregate tracked holdings across all bots on the connection, and the last reconciled exchange total. Non-bot holdings never enter bot capital, position quantity, cost basis or P&L. A final execution check prevents a sell from exceeding that bot's tracked quantity. The account total must reconcile to non-bot holdings plus all tracked bot positions.

After deploying, a fresh bot previously locked only because the account was prefunded can use Retry Start Checks once; no environment changes, manual sale or ledger reset are needed. Later untracked trades or changes to base-asset holdings still lock execution. An existing used ledger with unexplained surplus requires verified reconciliation rather than silently classifying missing fills as non-bot assets. The baseline records accounting ownership; it does not reserve or transfer exchange assets.

### Diagnostics and shareable logs

Open **Diagnostics & export** in the bot monitor, choose a period (1 hour through 14 days), and refresh the report. Download a readable Markdown report or JSON logs, or print the report. Share the downloaded file for troubleshooting; the application does not automatically upload it to this chat. It includes account/trading information, so share it deliberately.

The report includes configuration, current worker and inventory state, selected custom rules, strategy evaluations and indicator/rule values, AI analyses, risk approvals/rejections, orders, reconciled fills, closed trades, order events, run history and relevant bot audit events. It distinguishes no entry signal, an exit signal without a position, rejected entries and orders without fills. Findings summarize the available records rather than claiming one cause explains the entire period. Credentials, encrypted values, raw exchange payloads, headers and session data are excluded/redacted. Exporting never contacts the exchange or changes execution settings.

Migration 011 starts worker state-change history and 10-minute heartbeats. Worker history is bounded to 14 days and 10,000 records per bot; identical polls are deduplicated. Structured `BOT_DIAGNOSTIC` transition messages also appear in worker container logs. Candle evaluations now store calculated indicators; Trend v1 includes crossover, RSI, volume and price-structure checks, and custom rules include actual comparison values and crossover history. Old records cannot be backfilled with information that was never recorded.

Reports include the latest 500 records per category in the selected period, with total counts and an explicit truncation flag. Current positions/snapshots represent current state, not a reconstruction at the start of the period. Orders are selected by update time; fills by execution time. Diagnostic records do not replace the financial ledger or establish that an order was filled.

### Delete a bot

Use **Bots → Delete bot → Confirm delete**. Deletion stops and archives the bot, releases its configured allocation and subscription bot slot, and removes it from the default bot list. No exchange trade or liquidation is performed by Delete. A never-traded flat bot can be deleted immediately, including while running or with a disconnected exchange.

Deletion is blocked while a tracked position/cost or unresolved order remains. Bots with submitted orders need a completed reconciliation covering their last external order state. An already settled historical bot does not need to reconnect just because that reconciliation is old. Resolve real order/position uncertainty before deleting; deletion does not reset the ledger.

Choose **Show deleted bots · retained history** to inspect deleted bots and open their monitor, fills and diagnostic exports. Deleted bots cannot restart or change AI settings. Historical P&L remains part of workspace history. The default bot-list API excludes deleted records; `GET /api/bots?includeDeleted=true` includes retained records. Changes are tenant-scoped, CSRF/role protected, idempotent and audited with the acting user.

Migration 015 timestamps deletion and releases a futures contract's active ownership slot. A new futures bot can use that contract once the old bot is flat and settled; old fill identities and enrollment history remain available to reconciliation without reactivating the deleted bot.

### OKX order failures and recovery

OKX Spot market instruments may specify a maximum USDT value instead of a maximum base quantity. Validation accepts a positive notional ceiling alongside valid lot size and minimum quantity, while still rejecting missing or malformed limits. Rejected signals retain the attempted quantity, price and normalized limits; their outcome is `ENTRY_REJECTED` or `EXIT_REJECTED`.

Explicit, documented exchange validation/balance rejections become terminal `Rejected` orders with the original numeric code in order events. Generic failures, duplicate IDs, timeouts and lost acknowledgements remain `UNKNOWN`; they are never automatically resent. Futures order lookup also searches recent and archived terminal history when OKX returns 51603. Complete, identity-checked fills can recover a fully filled order even if order lookup is absent. Partial or absent evidence remains blocked; absence alone does not establish rejection.

New uncertainty locks preserve a durable resume request. After successful reconciliation (and futures contract verification), a bot that was running can resume monitoring and software protection. Pause, Stop, deletion and hard check failures clear that request. Old locks created before this update require **Retry Start Checks** once; unresolved exchange evidence still blocks them. The platform cannot reconstruct an original submission error that was never recorded.

HTTP 429, OKX rate-limit codes and supported temporary HTTP failures trigger exponential connection-level worker backoff from 30 seconds to five minutes without changing a running bot to permanently locked. Persistent hard failures and unresolved orders are also checked with backoff. OKX adapters share account request spacing and cooldown across Spot/futures instances within a process; this is not a distributed limiter across multiple processes. Recovery always reconciles before new execution and uses a fresh candle decision rather than replaying an old approved signal.

### Resolve a missing OKX Demo futures order

An Owner or Admin can open the bot monitor and use **Resolve an unconfirmed order** for an `UNKNOWN` OKX Demo perpetual order without an acknowledgement. Check the contract's exchange order/trade history, pending orders and positions, tick the confirmation, and confirm your platform password. **Verify and resolve missing order** stops the bot and queues read-only verification in the execution worker; it never sends a replacement order or an exchange cancellation.

The worker requires a flat local position, no recorded fills, no matching exchange order (including recent/archived terminal history), no open contract orders, no contract fills since five minutes before submission, and no exchange contract position. It follows pagination and refuses incomplete/error responses. Supported submissions must be at least ten minutes old and inside the adapter's seven-day fill-history window. Older orders need a separate verified history recovery; they are not silently cleared. Start is blocked while verification is pending.

Successful verification retains the order as `Cancelled` with an immutable `operator-recovery` event identifying the confirming user and evidence. This is an operator-assisted accounting resolution based on your confirmation plus current API evidence, not proof that OKX accepted or cancelled an order. It leaves the bot stopped. Review the result, then click Start for normal reconciliation and a fresh candle evaluation. Conflicting evidence refuses recovery and keeps `UNKNOWN`; exchange outages leave the request pending for automatic retry. Later fills are never erased or ignored.

The monitor distinguishes a recent check from a scheduled retry. A bounded five-minute retry plus a 30-second scheduling allowance suppresses the misleading stale-worker alert while displaying **waiting for scheduled retry**. This does not make market data fresh or prove worker health; an overdue retry restores the stale warning.
