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
