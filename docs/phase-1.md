# Phase 1 implementation status

## Implemented and locally validated

- npm workspace with React/Vite web app, Fastify API, shared TypeScript core, and independent worker.
- PostgreSQL development service, repeatable setup, restricted runtime role, tenant FORCE RLS, and immutable application audit history.
- Argon2id email/password authentication, development email verification/reset outbox, HTTP-only SameSite session cookies, Origin and CSRF checks, request throttling, session revocation, login history, and recent-password confirmation.
- Tenant-owned encrypted Testnet connection storage, permission validation, live rejection, per-connection adapters, bot creation and lifecycle endpoints, workspace stop-all, dashboard, signals, order history, and activity views.
- Versioned EMA/RSI/volume/price-structure strategy, risk-veto functions, decimal quantities, persisted order intents, unique client IDs, PostgreSQL locks, fill reconciliation, partial-fill cost accounting, public/private WebSocket scaffolding, conservative fail-closed behavior.
- Database integration tests prove that one workspace cannot list/start/create against another workspace's bot/connection; direct queries without predicates are still isolated by RLS.

## Required before calling Phase 1 complete

1. Private-stream subscription readiness, reconnect invalidation and in-flight account-change fencing are implemented. Complete direct authoritative private order/execution processing remains pending; REST pagination, durable watermarks and base/quote fee accounting are implemented and locally tested.
2. Portfolio reservations, instrument limits, closed-cycle results and observed peak-equity drawdown are implemented. Precise midnight equity/daily realized-unrealized accounting and unsupported fee handling still require production acceptance.
3. Implement and externally verify exchange-native protective orders. Stop cancels pending entries without flattening; Pause blocks new entries while retaining software exits; stopped inventory has no protective monitoring. These boundaries need real exchange/outage verification.
4. Durable intents, committed attempted-send markers, lifecycle events, ambiguous-acknowledgement reconciliation and multi-worker fault tests are implemented. Verify those behaviors against actual Testnet restarts, outages and partial fills.
5. Production Resend delivery and a Coolify deployment are implemented; verify the actual sender/DNS, backups, configuration/key rotation, security hardening, and live acknowledgement/re-authentication controls. Live connections stay disabled until then.
6. Verify two independent real Bybit Testnet accounts through the checks below. This requires working external network access and user-supplied Testnet credentials in the app. See [the read-only preflight and evidence runbook](testnet-acceptance.md).

## External Testnet acceptance checklist (not yet run)

- Register and verify two users. Connect separate dedicated Testnet accounts without withdrawal/transfer permissions.
- Confirm invalid, expired, read-only, dangerous-permission, IP-restricted, and region-restricted keys are surfaced correctly without credential leaks.
- Confirm instrument limits, account balances, candle/ticker freshness, public/private reconnect, and reconciliation of open orders, fills, balances, and tracked positions.
- Start a $100 bot on each account. Check that orders and fees match the exchange, and that allocation/trade size/risk limits reject oversized or stale candidates.
- Stop one user's bot and confirm the other user's activity continues. Explicitly verify existing-order/position handling.
- Kill/restart the worker around submission and fills; verify there are no duplicate orders, no lost fills, and no new entries before reconciliation completes.
- Confirm partial fills, cancellations, rejected orders, timeouts, rate limits, exchange outage, global stop, and database recovery all fail closed appropriately.
- Complete all remaining code items before intentionally enabling `TRADING_EXECUTION_ENABLED` in this preview. Do not use live funds.
