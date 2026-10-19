# Phase 2 — AI market intelligence

Phase 2 adds analysis and decision support to the Testnet development preview. It does not complete the remaining Phase 1 financial-execution work. Keep both trading switches disabled until the Phase 1 acceptance checklist is complete.

## Components

- `packages/ai-core`: provider-independent contracts, Zod JSON validation, versioned prompts, closed-candle market snapshots, and deterministic OFF/ADVISORY/FILTER policies.
- `packages/ai-providers`: OpenAI structured JSON and Anthropic forced-tool adapters. Both use fixed official HTTPS destinations, bounded responses, request timeouts, and schema validation. No adapter can invoke exchange operations.
- `packages/news`: curated CoinDesk/Cointelegraph RSS ingestion, URL normalization, duplicate removal, timestamp checks, response-size limits, and rejection of XML DTD/entities. Only headlines are analyzed; article bodies are not fetched.
- `apps/worker/src/intelligence.ts`: background shared-context warming, global call reservations/token accounting, news classification, and tenant-scoped decision persistence.
- `apps/api/src/intelligence-routes.ts`: AI readiness, decision history/comparison, public-news views, stopped-bot mode changes, and rate-limited manual analysis.
- `apps/web/src/Intelligence.tsx`: modes, confidence/regime/risk/reasons, independently stored bot history, news sentiment, and decision comparisons.

## Enable an actual provider

In the private server `.env` or secure runtime configuration, set:

```dotenv
AI_PROVIDER=openai
AI_MODEL=<model supporting the provider's structured-output API>
AI_API_KEY=<platform-owned credential entered securely>
AI_MAX_CALLS_PER_DAY=100
NEWS_ENABLED=false
LIVE_TRADING_PLATFORM_ENABLED=false
TRADING_EXECUTION_ENABLED=false
```

Alternatively set `AI_PROVIDER=anthropic`, `gemini` or `deepseek` and use its matching model and credential. Restart the API and worker after configuration changes. npm runtime commands enable Node 24’s `--use-env-proxy` so native fetch uses the cloud’s existing HTTPS proxy while retaining TLS verification. The model must support the adapter's structured-output request; unsupported models produce explicit failures. These adapters were verified with HTTP fixtures; actual provider/model compatibility requires an authenticated smoke test.

The AI key belongs to the platform owner, is used server-side only, and is never accepted through customer bot forms or returned to the browser. Do not commit credentials or paste them into chat. The public API readiness response reports configuration presence, not authenticated provider readiness.

Network destinations:

| Feature                        | Required host           |
| ------------------------------ | ----------------------- |
| OpenAI                         | `api.openai.com`        |
| Anthropic                      | `api.anthropic.com`     |
| Public Testnet market snapshot | `api-testnet.bybit.com` |
| CoinDesk RSS                   | `www.coindesk.com`      |
| Cointelegraph RSS              | `cointelegraph.com`     |

Set `NEWS_ENABLED=true` to opt into five-minute RSS polling. Provider availability is required for this combined ingestion/classification workflow. Failed headline analysis retries after 30 minutes; failures are shown without invented summaries.

## Operating modes

1. **OFF**: no bot AI analysis; strategy decisions and risk controls remain independent. News polling is separately controlled by the platform owner.
2. **ADVISORY**: records context and recommendations, but never changes a strategy candidate or order size. Failure remains strategy-only. If context is still warming when a candidate arrives, Advisory proceeds and records the unavailable context.
3. **FILTER**: requires fresh, valid analysis for a strategy entry. Missing, failed, stale, invalid, bearish, panic, uncertain, or SKIP results prevent entry. REDUCE_RISK caps the size modifier at 50%; any accepted modifier is at most 100%. Risk Engine vetoes always win. Protective exits never wait for or depend on AI.

Change a mode from **AI Analysis** while the bot is stopped. **Analyze now** fetches public closed-candle market data and records context without creating a signal or order. The automatic worker handles active bots at candle close and refreshes context when high-impact news changes. Standard news is frozen at the candle's close; newly classified high-impact news is overlaid to invalidate cached context without creating repeated orders for that candle.

Provider and news requests run in background jobs. The trading path only reads the cache. Filter candidates wait without submitting while context is being prepared; the existing bot/candle idempotency rule still permits only one finalized signal per candle. AI never has direct order-generation authority and no exchange key, tenant identity, balance, or portfolio is sent to the provider.

## Isolation, caching, budgets and migration

Shared cache entries contain market/news context only. They are keyed by provider, model, prompt version, closed-candle snapshot, and news. Cross-process PostgreSQL advisory locks avoid duplicate provider calls. Per-bot decisions are separate FORCE-RLS tenant records with tenant-bound bot and signal references. Manual context and strategy candidates retain different decision records even when the provider result is reused.

An atomic shared daily reservation counts each attempted provider call before network I/O, including failures. A process crash cannot roll back a consumed reservation. A budget of zero disables calls. Input/output tokens are recorded when supplied by successful provider responses. This is a call cap and usage record, not a monetary-spend guarantee or billing implementation. Cache TTLs bound reuse; failed requests have a short cooldown. Monthly pricing, provider-specific cost rates, fair scheduling between market/news jobs, and retention policies remain future operations work.

`npm run setup` applies checksum-verified numbered SQL migrations before granting the restricted application role access. Existing encryption keys, bot state, and private `.env` are preserved. `npm run db:migrate` applies schema migrations with the admin binding; setup also refreshes local grants for newly added tables. Never change a migration already applied to another database.

## Decision comparison and validation

The comparison screen counts strategy/risk-approved candidate snapshots and snapshots that would also pass Filter. It includes changed-news/manual decision contexts and is clearly labeled as decision data. It does **not** claim investment returns, backtested profitability, or AI performance superiority. A verified trade ledger and controlled experiments are still required for return/drawdown comparisons.

`npm test` creates and removes a temporary PostgreSQL database and mail outbox so fixture usage reservations do not consume the development database’s daily AI budget. The local admin role must have database-creation permission.

Run `npm test`, `npm run build`, and `npm audit --omit=dev --audit-level=high`. Coverage includes malformed/refused/truncated AI output, HTTP failures, cache reuse, per-tenant history/RLS, Filter vetoes, Advisory failure behavior, Risk Engine precedence, no AI-generated entries, no AI-dependent exits, quotas, RSS normalization, and parser/response limits.

Current-instance external RSS fetch and parsing succeeded: 25 CoinDesk articles and 30 Cointelegraph articles were parsed. This does not validate AI summaries or sentiment.

External checks still required: a configured owner AI credential and compatible model, actual provider responses and token usage, and real Testnet market/exchange acceptance. No external provider calls or news sentiment should be described as verified until those checks run. See [Phase 1](phase-1.md) for the remaining execution blockers.
