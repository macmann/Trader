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
- Testnet execution defaults **Off** in **Admin Settings**. The worker can evaluate signals but cannot submit orders until a platform administrator enables it with password confirmation and acknowledgement, after completing the Testnet acceptance checklist. Do not enable it merely because unit tests pass.
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

For a hosted deployment, use [the Coolify guide](docs/coolify.md) and `/docker-compose.yaml`. PostgreSQL, internal database credentials, migrations and health checks are included. Trading stays disabled.

## Coolify: only two required variables

```env
APP_ORIGIN=https://tradingbot.b-connect.site
APP_ENCRYPTION_KEY=<permanent 64-character hex key>
```

Generate the encryption key once with `openssl rand -hex 32` and back it up securely. Set the Compose location to `/docker-compose.yaml`, assign your HTTPS domain to **web** port **3000**, and deploy. No database URL, database passwords or external API keys are required. Internal database passwords are generated into persistent Docker secret volumes; PostgreSQL has its own persistent data volume and no published port.

After web and worker become healthy, open the **web** service terminal in Coolify and retrieve the one-time installation token:

```sh
cat /run/app-secrets/setup-token
```

Open your domain and use that token to create the initial platform administrator. This server-authorized account can sign in without email delivery; ordinary users still require email verification. Setup closes permanently after initialization. Keep the token private and do not paste it into chat or logs.

Open **Admin Settings** to configure Resend sender/key, AI provider/model/key and daily budget, news, Telegram token, or billing webhook secret. These values are encrypted in PostgreSQL using the external master key. Saved secrets are never returned to the browser; replacing or clearing one requires your account password. New requests and worker cycles use saved settings without redeployment. Public registration and email recovery are unavailable until Resend is configured. Verify your sending domain before enabling it.

Back up **all three volumes** (`postgres-data`, `admin-secrets`, `app-secrets`) and `APP_ENCRYPTION_KEY`; never delete volumes on redeployment. Existing installations using an external database need an intentional database restore/migration before switching to the bundled deployment. This change does not automatically transfer your old database. See [the full deployment, backup and recovery guide](docs/coolify.md).

The default `docker-compose.yaml` starts `initialize`, `postgres`, `migrate`, `web` and `worker` automatically; `compose.coolify.yaml` is a compatibility mirror. PostgreSQL uses Docker DNS `postgres:5432`, not the development localhost URLs. Database and migration readiness are checked before API startup with bounded retries. `POSTGRES_DB`, `POSTGRES_USER` and `APP_DATABASE_USER` have safe identifier defaults and are optional; passwords remain automatically generated. No manual migration, Redis, separate database resource or custom network is required. See [startup sequence, variable defaults, verification and deployment limitations](docs/coolify.md#default-compose-file-and-startup-readiness).

Keys created at `testnet.bybit.eu` require **Bybit EU Testnet (.eu)**, which uses `api-testnet.bybit.eu` and EU public/private WebSocket hosts. **Bybit Global Testnet (.com)** remains a separate option. Neither connector retries credentials on another region's host. EU mainnet remains an explicit **LIVE, read-only preview**, with no bot/order execution. See [Bybit regions and authentication](docs/bybit-regions.md).

To enable simulated exchange orders, open **Admin Settings → Testnet order execution**, choose **On — Testnet only**, check the acknowledgement and confirm your platform password. This is a persisted installation setting; do not set `TRADING_EXECUTION_ENABLED` in Coolify or edit Compose. Workers pick up changes without restarting and recheck the setting immediately before submission. Turning it off blocks new submissions, including software exit orders; it does not liquidate positions or reverse orders already sent. Cancellation/reconciliation continue. Stopped bots need to be started separately, and Live trading remains disabled.
