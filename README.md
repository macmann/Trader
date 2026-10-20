# Trader

A multi-tenant crypto trading workspace. Phase 1 implementation in progress; this is a development Testnet preview, not a production trading release.

## Run locally

Requires Node.js 24+, npm 11+, and Docker with Compose.

```sh
npm ci
npm run setup
npm run build
npm run dev
```

The API serves the built React dashboard on port 3000. For frontend hot reload, run `npm run dev:web` separately, set `APP_ORIGIN=http://localhost:5173` in `.env`, and restart the API. Run `npm run worker` in a separate terminal for market/strategy processing. Use the existing checkout; each cloud task is already isolated and does not need a worktree.

`npm run setup` starts local PostgreSQL, creates the schema and a restricted application database role, and generates a private `.env` only if absent. Re-running preserves the encryption key and database contents. Local passwords in Compose and `.env.example` are development defaults, not production credentials. `DATABASE_ADMIN_URL` is only for setup/migrations; runtime `DATABASE_URL` must use the non-superuser `trader_app` role. Application startup rejects database roles that bypass RLS. The worker also requires that restricted role. The initial schema is idempotent; subsequent schema evolution uses checksum-verified numbered migrations.

Register with a password of at least 12 characters. Development verification/reset messages are written to `.local/mail.jsonl` with private filesystem permissions. Open the relevant link, then sign in. That file contains single-use account tokens: keep it private. Production mode requires configured Resend delivery and an HTTPS application origin; it never uses this local outbox.

Connect a **dedicated Bybit Testnet** account in Exchanges, using an API key with account read and Spot trading permissions and no withdrawal/transfer permissions. The secret is validated server-side and stored with AES-256-GCM encryption bound to workspace, connection, and environment. It is never returned by the API. Keep `APP_ENCRYPTION_KEY` outside Git and backed up securely; replacing it makes existing credentials unreadable. Disconnecting requires flat positions and no unresolved orders, then clears stored ciphertext and stops dependent bots.

Create a Spot bot, initially stopped, with a supported pair, a $100 accounting allocation and $20 maximum trade. This does not transfer funds. The current strategy uses 15-minute candles and version `trend-v1.0`. Start initiates reconciliation before RUNNING. See Signals, Orders, and Activity for decisions and audit events.

## Execution controls and current limitations

- `LIVE_TRADING_PLATFORM_ENABLED=false` is mandatory for this preview. Live connections are rejected even if the flag is changed. Full live acknowledgement/re-authentication controls and production operations are still pending.
- `TRADING_EXECUTION_ENABLED=false` is the default. The worker can evaluate signals but cannot submit orders until this flag is intentionally enabled and the Testnet acceptance checklist has been completed. Do not enable it merely because unit tests pass.
- Stop cancels resting entries after reconciliation but does not liquidate positions. Pause blocks entries while retaining software risk exits. Stopped bots have no protective monitoring. Software protection requires a healthy worker and fresh authenticated feeds; exchange-native protective orders remain pending.
- BTCUSDT/ETHUSDT/SOLUSDT Spot and a single tracked position per bot are supported. Phase 2 adds OFF/ADVISORY/FILTER market intelligence; see [AI setup and behavior](docs/phase-2.md). Derivatives and short entries are unsupported.
- Public WebSocket events establish freshness. Private WebSocket authentication and heartbeat gate trading; authoritative order/fill details are currently reconciled with REST. Full event-driven private-stream processing remains pending.
- Execution intents are persisted before submission using unique Bybit `orderLinkId` values. Unknown order outcomes lock the bot and are never blindly retried. Cross-process PostgreSQL advisory locks and row locks serialize bot activity; there is no Redis/BullMQ queue yet.
- Reconciliation deduplicates fills, handles partial fills and quote/base-asset fees, pages bounded exchange history and retains reservations until terminal orders have matching executions. Unknown outcomes or unsupported fees lock execution. Durable intent and attempted-send markers support restart recovery without blind retries.
- Daily loss uses today's fills plus negative unrealized P&L; it remains a conservative approximation rather than a midnight equity ledger. Drawdown uses observed equity peaks and consecutive losses use closed trade cycles. Duplicate connections to one underlying exchange account are not detected. Legacy execution records require a verified ledger rebuild after migration 004. See Phase 3 documentation for boundaries.
- The global execution stop is a database control: an operator using the admin connection can set `platform_controls.execution_stopped=true`. The application role cannot change this switch. There is no public admin endpoint.
- Tenant tables use FORCE RLS, explicit tenant predicates, and tenant-bound foreign keys for bots/connections. Audit records cannot be updated or deleted by the application role. This is not a complete production security audit.

## Validation

```sh
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Tests create an isolated temporary PostgreSQL database and private test mail outbox, remove both after the run, and use transient `test-…@example.com` fixture accounts. They test password hashing, verification, login, cookies, CSRF, reset token replay, session revocation, tenant isolation through APIs and direct RLS queries, stop controls, secret redaction, risk vetoes, encryption integrity/context binding, and restart-safe duplicate-fill accounting. They do not place external orders.

The authenticated Bybit acceptance checks require customer-owned Testnet credentials entered through the app and network access to `api-testnet.bybit.com` and `stream-testnet.bybit.com`. Never paste exchange secrets into chat or put a universal user-trading key in `.env`.

See [Phase 1 status and acceptance checklist](docs/phase-1.md) and the [product specification](docs/product-spec.md).

Phase 2 AI contracts, adapters, cache, history, news, and dashboard are implemented. AI remains disabled by default until a platform owner configures a supported provider/model/credential. See [Phase 2 configuration and validation](docs/phase-2.md).

Phase 3 adds multi-pair strategy/configuration and Portfolio controls. Trend, Breakout, Limit, bounded DCA and accumulation-grid paths have worker integration and simulated exchange tests. See [Phase 3 execution and remaining release requirements](docs/phase-3.md).

Phases 4–5 add organization roles, plan quotas and a signed billing gateway, OKX Demo, Gemini/DeepSeek, in-app/optional Telegram notifications, PWA assets, historical and walk-forward research, independent paper sessions and a versioned strategy marketplace. Open **Platform** in the dashboard. See [Phases 4–5 workflows and integration boundaries](docs/phase-4-5.md). Payment collection, externally accepted integrations and live trading remain disabled/unverified.

Run `npm run testnet:preflight` for a read-only, sanitized readiness report. It never submits orders and cannot certify external acceptance. See [Testnet acceptance and reliability](docs/testnet-acceptance.md).

For a hosted deployment, use [the Coolify guide](docs/coolify.md) and `/compose.coolify.yaml`. It connects to your existing shared PostgreSQL server and includes one-shot migrations, a restricted application role, production email, web/worker health checks and disabled trading defaults.

## Coolify mandatory environment

Deploy `/compose.coolify.yaml` with these variables in Coolify:

```env
APP_ORIGIN=https://tradingbot.b-connect.site
APP_ENCRYPTION_KEY=<permanent 64-character hex key>
DATABASE_URL=postgresql://trader_app:ENCODED_PASSWORD@HOST:5432/trader?sslmode=verify-full
DATABASE_ADMIN_URL=postgresql://trader_migrator:ENCODED_PASSWORD@HOST:5432/trader?sslmode=verify-full
APP_DATABASE_USER=trader_app
MAIL_FROM=Trading Bot <accounts@b-connect.site>
RESEND_API_KEY=<Resend sending key>
```

Generate the encryption key once with `openssl rand -hex 32` and keep a secure backup. Replace placeholders and URL-encode database usernames/passwords. Both URLs must point to the same dedicated Trader database on your shared PostgreSQL server. Pre-create separate migration-owner and restricted runtime roles; `APP_DATABASE_USER` must match the username in `DATABASE_URL`. The runtime role must not own tables or bypass RLS. Only the migration service receives `DATABASE_ADMIN_URL`.

Use a database hostname reachable from containers. For a trusted private database network without TLS, use `sslmode=disable` in both URLs. Individual `PG*` fields are unnecessary. Verify `b-connect.site` in Resend before using the example sender. Assign `https://tradingbot.b-connect.site` to the **web** service on container port **3000** and point DNS to your Coolify server. Trading stays disabled. See [the full provisioning and deployment guide](docs/coolify.md).
