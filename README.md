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

`npm run setup` starts local PostgreSQL, creates the schema and a restricted application database role, and generates a private `.env` only if absent. Re-running preserves the encryption key and database contents. Local passwords in Compose and `.env.example` are development defaults, not production credentials. `DATABASE_ADMIN_URL` is only for setup/migrations; runtime `DATABASE_URL` must use the non-superuser `trader_app` role. Application startup rejects database roles that bypass RLS. The worker also requires that restricted role. Migration SQL is idempotent for this initial schema; later schema evolution needs numbered migrations.

Register with a password of at least 12 characters. Development verification/reset messages are written to `.local/mail.jsonl` with private filesystem permissions. Open the relevant link, then sign in. That file contains single-use account tokens: keep it private. Production mode intentionally refuses startup until a real email delivery integration is implemented.

Connect a **dedicated Bybit Testnet** account in Exchanges, using an API key with account read and Spot trading permissions and no withdrawal/transfer permissions. The secret is validated server-side and stored with AES-256-GCM encryption bound to workspace, connection, and environment. It is never returned by the API. Keep `APP_ENCRYPTION_KEY` outside Git and backed up securely; replacing it makes existing credentials unreadable. Disconnecting clears stored ciphertext and stops dependent bots.

Create a BTCUSDT Spot bot, initially stopped, with a $100 accounting allocation and $20 maximum trade. This does not transfer funds. The current strategy uses 15-minute candles and version `trend-v1.0`. Start initiates reconciliation before RUNNING. See Signals, Orders, and Activity for decisions and audit events.

## Execution controls and current limitations

- `LIVE_TRADING_PLATFORM_ENABLED=false` is mandatory for this preview. Live connections are rejected even if the flag is changed. Full live acknowledgement/re-authentication controls and production operations are still pending.
- `TRADING_EXECUTION_ENABLED=false` is the default. The worker can evaluate signals but cannot submit orders until this flag is intentionally enabled and the Testnet acceptance checklist has been completed. Do not enable it merely because unit tests pass.
- Stop/pause prevents further order submission, but does not cancel already submitted exchange orders or liquidate positions. Existing risk monitoring is not maintained for stopped/paused bots. Software stop-loss/take-profit checks require a RUNNING worker, fresh market feed, private stream, and successful reconciliation. Exchange-native protective orders are pending.
- Only BTCUSDT Spot, a single position per bot, and AI OFF are supported. AI is Phase 2. Derivatives and short entries are unsupported.
- Public WebSocket events establish freshness. Private WebSocket authentication and heartbeat gate trading; authoritative order/fill details are currently reconciled with REST. Full event-driven private-stream processing remains pending.
- Execution intents are persisted before submission using unique Bybit `orderLinkId` values. Unknown order outcomes lock the bot and are never blindly retried. Cross-process PostgreSQL advisory locks and row locks serialize bot activity; there is no Redis/BullMQ queue yet.
- Reconciliation deduplicates exchange execution IDs, handles partial fills with quote-currency fees, and rejects unknown orders/account BTC discrepancies. Non-quote fees, paginated execution history, or uncertain order outcomes lock execution for review. Full historical pagination, base-asset fees, order-event history, and reliable recovery after extended downtime are pending. Most standard Spot buys charge base-asset fees, so this is a required remaining reconciliation item.
- Current daily-loss/drawdown accounting is preliminary, based on fills and tracked equity; it is not the final daily realized/unrealized ledger or peak-equity drawdown implementation. Any net realized loss blocks new entries conservatively. Accurate consecutive-loss accounting and account-wide capital reservations are pending. Use one bot per dedicated Testnet account until those controls are complete.
- The global execution stop is a database control: an operator using the admin connection can set `platform_controls.execution_stopped=true`. The application role cannot change this switch. There is no public admin endpoint.
- Tenant tables use FORCE RLS, explicit tenant predicates, and tenant-bound foreign keys for bots/connections. Audit records cannot be updated or deleted by the application role. This is not a complete production security audit.

## Validation

```sh
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Tests use a real local PostgreSQL database and transient `test-…@example.com` fixture accounts. They test password hashing, verification, login, cookies, CSRF, reset token replay, session revocation, tenant isolation through APIs and direct RLS queries, stop controls, secret redaction, risk vetoes, encryption integrity/context binding, and restart-safe duplicate-fill accounting. They do not place external orders.

The authenticated Bybit acceptance checks require customer-owned Testnet credentials entered through the app and network access to `api-testnet.bybit.com` and `stream-testnet.bybit.com`. Never paste exchange secrets into chat or put a universal user-trading key in `.env`.

See [Phase 1 status and acceptance checklist](docs/phase-1.md) and the [product specification](docs/product-spec.md).
