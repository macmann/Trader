# Phases 4 and 5 — platform and strategy marketplace

This development release combines organization access, workspace entitlements, a second exchange connector, additional AI providers, notifications, installable web assets, research/paper trading and a versioned marketplace. It preserves the earlier release boundaries: live trading is rejected, execution defaults off, production email/deployment acceptance is incomplete, and no external exchange/AI/payment/Telegram acceptance is claimed from fixture tests.

## Platform workflow

Open **Platform** in the dashboard. Its tabs provide Research, Paper trading, Marketplace, Workspace, Subscription and Notifications. Existing Portfolio and exchange/bot workflows remain available.

Every account retains one personal workspace. An owner/admin can create up to five organizations per account, switch the session's active workspace and add existing verified accounts. There is no invitation email or ownership-transfer flow. Organization membership requires the owner/admin to enter the registered email; no messages are sent automatically. The member can select the organization from their workspace selector. Membership and current role are resolved on every request; removing a member or changing their role takes effect on the next request.

| Role   | Access                                                                              |
| ------ | ----------------------------------------------------------------------------------- |
| Owner  | Workspace administration, member/admin roles, trading, research and publishing      |
| Admin  | Manage trader/viewer members and settings; cannot grant admin or alter the owner    |
| Trader | Bot lifecycle/configuration, research, paper sessions and marketplace subscriptions |
| Viewer | Read workspace data and mark notifications read; cannot change trading/settings     |

Sensitive membership, credential and Telegram-setting changes require recent password confirmation through Security. Active workspace selection is session-specific. Tenant data uses FORCE RLS and explicit predicates; membership discovery additionally uses authenticated user scope. Marketplace catalog records intentionally allow published, sanitized configuration/performance reads across workspaces, without exposing creator emails or exchange credentials.

## Plans and billing gateway

New workspaces receive FREE. Migration 005 grants existing development workspaces PRO to preserve already-configured multiple bots; this is a development entitlement, not evidence of payment. No checkout, charges, recurring collection or creator payouts occur in this build.

| Plan  | Bots | Connections | Paper sessions | Research runs/month | AI analyses/month | Version subscriptions |
| ----- | ---: | ----------: | -------------: | ------------------: | ----------------: | --------------------: |
| FREE  |    1 |           1 |              1 |                  10 |                20 |                     5 |
| BASIC |    3 |           3 |              3 |                 100 |               500 |                    20 |
| PRO   |   10 |          10 |             10 |               1,000 |             5,000 |                   100 |

Monthly usage is per workspace in UTC and counts persisted research requests and new bot AI decisions, including cache-backed/failed decisions. It is separate from the existing global AI provider-call/token budget. Limits serialize concurrent writes. Expired, past-due or cancelled plans fall back to FREE. Downgrades preserve existing data; new buys are vetoed if the workspace exceeds its bot allowance, while reconciliation and protective sells remain available. Session counts include stopped experiments until deleted.

A platform-owned billing integration may send signed events to `POST /api/billing/gateway`. Configure a strong `BILLING_WEBHOOK_SECRET` outside Git. This is an integration contract, not a direct Stripe-compatible endpoint. A payment processor integration must verify its own processor webhook and authoritative customer/workspace mapping before forwarding an event; never sign a customer-supplied upgrade request blindly.

The strict body is `{id, tenantId, plan, status, periodEnd, occurredAt}` in that canonical order. `plan` is FREE/BASIC/PRO; `status` is ACTIVE/PAST_DUE/CANCELLED; dates are ISO timestamps. Set `x-billing-timestamp` to Unix seconds and `x-billing-signature` to lowercase hex HMAC-SHA256 over `timestamp + '.' + JSON.stringify(canonicalBody)`. The exported `billingSignature` helper implements this contract. The timestamp must be within five minutes; event IDs deduplicate, older events cannot overwrite newer entitlements, and unsigned requests cannot change plans. Missing configuration returns 503.

## Exchanges and AI

The exchange adapter registry supports Bybit Testnet and OKX Demo. Select the provider when connecting; OKX also requires its passphrase. Both reject withdrawal/extra permissions and live connections, keep credentials server-side under tenant/environment-bound encryption, and use separately authenticated account streams. OKX uses signed V5 requests, the demo header, Spot cash orders, alphanumeric client IDs, normalized instrument/fee/order data and exchange-order identity during reconciliation when fills lack client IDs. Public/private freshness is keyed by provider, preventing a Bybit update from authorizing an OKX order. Unsupported providers fail closed. No other exchange is advertised as implemented.

Both adapters feed the existing final risk/execution gates. OKX Demo uses `www.okx.com` and `wspap.okx.com:8443`; the worker retains the inherited TLS-verified HTTPS proxy agent. Authenticated access, regional availability and actual exchange responses must be accepted separately before enabling execution. No regional restriction is bypassed.

`AI_PROVIDER` additionally accepts `gemini` or `deepseek`, alongside `openai`, `anthropic` and `disabled`. Set a matching `AI_MODEL` and platform-owned `AI_API_KEY` securely, then restart API/worker. Gemini uses schema-constrained JSON with a secret header; DeepSeek uses JSON output plus local Zod validation. Every provider enforces the same no-order-generation contract and bounded response handling. Filter mode fails closed on quota/provider/validation failures; Advisory preserves strategy decisions. Gemini requires `generativelanguage.googleapis.com`; DeepSeek requires `api.deepseek.com`. Provider/model compatibility has been tested with HTTP fixtures, not authenticated external accounts.

## Research and walk-forward testing

Upload or paste a JSON array of 15-minute candles with `time` (Unix milliseconds), `open`, `high`, `low`, `close`, `volume`. The API rejects invalid ranges, duplicate/out-of-order/missing bars and datasets above 5,000 candles. Data is supplied by the user and is not certified exchange history. Each saved run records the data hash, exact strategy/configuration, fee/slippage assumptions, engine version and result. Runtime grants prevent updating/deleting historical runs.

The deterministic Spot engine evaluates each closed bar and fills the resulting signal on the next bar. Market fills include configured slippage; Limit fills use the next available open or the configured price when touched, subject to expiry. Capital, sizing, daily loss/trade counts, observed drawdown, consecutive losses and layer limits constrain entries. Stop/take-profit conflicts within one OHLC bar assume the adverse stop first. Trailing levels use previously observed peaks, not a future intrabar path. Final historical positions are explicitly liquidated at end-of-data with fees/slippage; paper sessions retain inventory and pending intents. Results include cash, equity, fees, net/unrealized P&L, closed-trade counts, win rate, profit factor, drawdown, fills and equity history. This bounded bar model does not simulate order-book liquidity, queue position, partial exchange fills, funding, derivatives or AI historical context.

Walk-forward testing accepts up to six candidate parameter sets, at least 60 training bars and 15 test bars, with up to eight rolling folds. It selects by training return minus drawdown and evaluates the selected candidate only in the subsequent test window, using earlier candles solely for indicator warmup. Each out-of-sample window starts independently with the configured capital; the reported mean return is not a compounded portfolio return. The UI compares the configured DCA step with 1.5× that step; the API accepts complete validated advanced configurations. Selection/tests are deterministic, and future test prices cannot influence an earlier training selection.

## Independent paper trading

Paper sessions never load exchange credentials or call order endpoints. **Replay** sessions advance only with the next uploaded candle batch and expected revision, so duplicate/stale requests cannot double-fill. Stored candles/configuration reconstruct the same position and pending intent after a worker restart. Stop freezes an experiment; deleting it frees a plan slot.

**Market** sessions are advanced by a separate worker job using public OKX candles with no API credentials or exchange connection. Bars before session creation serve only as warmup; they do not generate historical paper trades. Only closed, fresh bars advance state. A feed gap or 5,000-bar history limit stops the session and creates a notification. Public market access is required; without it the session waits and the worker reports a feed failure rather than inventing data. Paper/notification I/O runs outside the trading cycle so slow optional services do not serially block order monitoring.

## Marketplace

An owner/admin publishes a listing from an owned stored BACKTEST run. Arbitrary scripts, arbitrary claimed performance and user-submitted verified/live results are not accepted. Each published version freezes the exact supported strategy version, symbol, bot/risk parameters, dataset hash, fee settings and historical metrics. Additional publications create monotonically numbered versions; old versions/results cannot be updated through the runtime role.

DCA/grid classifications are VERY_HIGH and other strategies are HIGH. These conservative labels do not certify suitability or profitability. Historical results are always marked simulated and never labelled verified live. There are no return guarantees.

Subscriptions pin a specific version. New publications do not modify subscribers' bots. Creating a bot from a subscription copies the server-owned version configuration and creates it STOPPED; user-supplied overrides cannot replace the pinned settings. Configuration edits detach marketplace provenance. Retiring a listing removes it from discovery and new use while preserving existing bot configuration/history. Unsubscribing does not stop or modify an existing bot.

The owner can publish an append-only evidence snapshot from a matching, owned marketplace bot with ledger version 2 and closed reconciled executions. The server derives results from stored trade cycles; the request cannot supply performance numbers. Testnet and Live evidence have separate fields/labels. Evidence reports closed-trade return and closed-trade drawdown, excluding open P&L and intratrade drawdown. Live evidence remains unavailable while live execution is disabled; no fixture record is proof of a real externally tested account. Evidence is attached to the specific tested bot, not an aggregate promise about all subscribers.

## Notifications and PWA

Audit events and important order events create tenant-scoped in-app notifications. To deliver event titles to Telegram, the platform owner supplies `TELEGRAM_BOT_TOKEN` securely and a workspace owner/admin enables a chat ID. Users must initiate/contact the platform bot themselves; this release does not discover or claim chat ownership. Messages omit credentials, balances and raw audit payloads. Dispatch uses a committed attempt marker. Failed/uncertain sends are marked FAILED and are not automatically retried, so delivery is best effort rather than guaranteed. No real messages are sent by tests.

The dashboard includes a manifest, SVG icon, service worker and offline page. Installability depends on a browser and secure origin. The service worker caches static assets only: it never caches API responses, account data, sessions or trading actions. Navigation requires the server; offline navigation shows a reconnect message. No offline trading controls or mobile push are implemented.

## Setup and verification

Run `npm ci`, `npm run setup`, `npm test`, `npm run build`, and `npm audit --omit=dev --audit-level=high`. Setup applies checksum-verified migration 005, seeds owner memberships and plan records, updates grants, and preserves private encryption keys. Do not edit an applied migration.

The suite covers real PostgreSQL RLS, role removal/escalation, concurrent plan quotas, signed billing replay/order handling, immutable/pinned marketplace versions, server-derived Testnet evidence, paper replay/automatic-feed recovery, research timing and walk-forward separation, additional AI contracts, OKX signing/order normalization and lost-acknowledgement worker recovery. External exchange, AI, Telegram and payment services use fixtures or remain unrun. Keep `TRADING_EXECUTION_ENABLED=false` and `LIVE_TRADING_PLATFORM_ENABLED=false` until the earlier exchange/production acceptance prerequisites are satisfied.
