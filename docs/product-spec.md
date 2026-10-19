# AI Trading Bot Platform

## Production Product Specification

Version: 1.0
Initial Exchange: Bybit
Architecture: Multi-tenant SaaS
Trading Modes: Testnet / Live
Initial Market: Crypto
Primary Approach: Strategy + AI Market Intelligence + Risk Engine

---

# 1. PRODUCT VISION

Build a shared trading automation platform where each user can:

1. Create their own account.
2. Log into the platform.
3. Connect their own exchange account using API credentials.
4. Never transfer exchange funds into the platform.
5. Configure how much capital a bot may use.
6. Choose trading pairs.
7. Configure a trading strategy.
8. Enable or disable AI market analysis.
9. Run the bot on Testnet before using real funds.
10. Monitor trades, balances, profit/loss and AI recommendations.
11. Stop a bot immediately.
12. Run multiple independent bots.
13. Eventually connect multiple exchanges.

The platform acts as:

Trading automation + analytics + AI decision-support software.

It should NOT behave as an exchange or wallet.

---

# 2. CORE OPERATING MODEL

Example:

User A

Bybit account balance:
$5,000

User creates:

BTC Bot

Allocated capital:
$100

The bot can therefore only use a maximum configured allocation of:

$100

even though the exchange account contains:

$5,000

Example:

User B

Bybit balance:
$2,000

ETH Bot allocation:
$250

User C

Bybit Testnet account

SOL Bot simulated allocation:
$100

All three run completely independently.

---

# 3. MULTI-TENANCY

Every database record that belongs to a customer must be scoped by:

user_id

or preferably:

tenant_id

Core hierarchy:

User
└── Workspace
├── Exchange Connections
├── Bots
├── Strategies
├── Trades
├── Positions
├── AI Analyses
├── Alerts
└── Billing

For V1:

1 user = 1 workspace

But build the schema so later you can support:

Organization
├── Owner
├── Admin
├── Trader
└── Viewer

---

# 4. AUTHENTICATION

Support:

Email/password

Later:

Google login
Apple login
Passkeys
2FA

Required security:

Password hashing with Argon2id or equivalent.

Secure HTTP-only session cookies.

CSRF protection.

Rate limiting.

Email verification.

Password reset.

Login history.

Session management.

Optional TOTP 2FA.

Sensitive account actions should require re-authentication.

Examples:

Changing exchange API credentials.

Enabling Live Trading.

Removing an exchange.

Changing withdrawal-related security configuration.

---

# 5. USER ONBOARDING

Flow:

Register
↓
Verify email
↓
Create workspace
↓
Dashboard
↓
Connect Exchange
↓
Create Bot
↓
Run Testnet
↓
Review Results
↓
Optional Live Mode

---

# 6. EXCHANGE CONNECTION

Initial provider:

Bybit

Architecture must support:

ExchangeAdapter

Implementations:

BybitAdapter
OKXAdapter
BinanceAdapter
KrakenAdapter
CoinbaseAdapter

later.

Interface:

```ts
interface ExchangeAdapter {
  validateCredentials(): Promise<ExchangeValidation>;

  getBalances(): Promise<Balance[]>;

  getInstrument(symbol: string): Promise<Instrument>;

  getTicker(symbol: string): Promise<Ticker>;

  getCandles(
    symbol: string,
    timeframe: string,
    limit: number,
  ): Promise<Candle[]>;

  getOpenOrders(): Promise<Order[]>;

  getPositions(): Promise<Position[]>;

  placeOrder(request: OrderRequest): Promise<OrderAcknowledgement>;

  cancelOrder(exchangeOrderId: string): Promise<void>;

  getOrder(exchangeOrderId: string): Promise<Order>;

  subscribePrivateEvents(): Promise<void>;
}
```

---

# 7. CONNECTING BYBIT

User navigates:

Settings
→ Exchanges
→ Connect Exchange
→ Bybit

Form:

Connection Name

Example:

My Bybit

Environment:

TESTNET
LIVE

API Key

API Secret

Optional:

Account label

User clicks:

TEST CONNECTION

Backend calls Bybit.

Validate:

Credentials valid.

API-key status.

Permissions.

Read/write status.

IP binding.

Account accessibility.

Trading capabilities.

Never expose the secret back to the browser after storage.

---

# 8. API PERMISSIONS

The application should request only the minimum necessary API permissions.

Required:

Read account data.

Read positions.

Read orders.

Create/cancel supported trades.

DO NOT require:

Withdrawal permission.

Crypto withdrawal.

Asset transfer permission unless a very specific future feature requires it.

The UI should show:

✓ Read Account

✓ Trading

✗ Withdrawals

If dangerous permissions are detected, display:

HIGH-RISK API CONFIGURATION

and preferably refuse the connection.

---

# 9. API CREDENTIAL STORAGE

API secrets are among the most sensitive information in the entire system.

Never store:

plain text secrets.

Never return:

API secret through API responses.

Never log:

API secret.

Never expose:

API secret to frontend code.

Storage model:

exchange_connections

id

tenant_id

provider

environment

api_key_encrypted

api_secret_encrypted

encryption_key_version

status

permissions

ip_binding

last_verified_at

created_at

updated_at

Use application-level envelope encryption.

Recommended model:

Master key
↓
Key Management Service
↓
Data Encryption Key
↓
Encrypted API credentials

For a small self-hosted deployment initially:

Use AES-256-GCM encryption with a master encryption key stored outside PostgreSQL.

Later:

AWS KMS
Google Cloud KMS
HashiCorp Vault
Azure Key Vault

The master encryption key must never be committed to Git.

---

# 10. EXCHANGE CONNECTION STATUS

Statuses:

CONNECTED

INVALID_CREDENTIALS

PERMISSION_ERROR

DISCONNECTED

EXPIRED

RATE_LIMITED

REGION_RESTRICTED

UNKNOWN_ERROR

Bot execution must stop if its connection becomes unusable.

---

# 11. BOT MODEL

One user can create multiple bots.

Example:

BTC Trend Bot

ETH Swing Bot

SOL Breakout Bot

BTC AI Experimental Bot

Bot fields:

id

tenant_id

exchange_connection_id

name

symbol

market_type

timeframe

environment

strategy_id

capital_allocation

max_position_allocation

status

ai_enabled

risk_profile

created_at

updated_at

---

# 12. BOT STATES

STOPPED

STARTING

RUNNING

PAUSED

RISK_LOCKED

EXCHANGE_ERROR

AI_ERROR

ERROR

STOPPING

ARCHIVED

---

# 13. TESTNET VS LIVE

Each exchange connection explicitly has:

environment = TESTNET

or:

environment = LIVE

Never use the same credential record for both.

Each bot inherits the environment from its exchange connection.

UI:

TESTNET bots:

Blue/Test label.

LIVE bots:

Large LIVE warning.

Before enabling LIVE for the first time:

Display confirmation.

Example:

You are enabling automated trading with real funds.

Require:

Password confirmation.

Checkbox acknowledgement.

Optional 2FA.

---

# 14. CAPITAL ALLOCATION

Example:

Exchange account:

$2,400

Bot allocation:

$100

This does NOT mean transferring $100 anywhere.

It means:

maximum accounting allocation = $100

The Risk Engine ensures this bot does not intentionally exceed the configured exposure.

Configuration:

Total allocation:
$100

Maximum trade size:
$20

Maximum open positions:
1

Maximum allocation per trade:
20%

Risk per trade:
1%

---

# 15. BOT CONFIGURATION UI

Create Bot:

Bot Name

BTC AI Bot

Exchange:

My Bybit Testnet

Pair:

BTCUSDT

Timeframe:

1m
5m
15m
30m
1h
4h
1d

Recommended initial:

15m

Capital:

$100

Maximum trade value:

$20

Market:

Spot

Future:

Linear Perpetual
Inverse
Options

Strategy:

Trend Strategy

AI Analysis:

OFF / ON

Mode:

AI OFF
AI ADVISORY
AI FILTER
AI WEIGHTED

Risk Configuration:

Stop loss %

Take profit %

Daily loss limit

Maximum drawdown

Maximum trades/day

Maximum consecutive losses

---

# 16. STRATEGY ENGINE

Strategies must not know anything about Bybit.

Interface:

```ts
interface TradingStrategy {
  id: string;
  version: string;

  evaluate(context: StrategyContext): Promise<StrategySignal | null>;
}
```

Output:

```ts
interface StrategySignal {
  symbol: string;

  direction: "LONG" | "SHORT" | "EXIT" | "NONE";

  strength: number;

  stopLoss?: number;

  takeProfit?: number;

  reason: string[];

  timestamp: number;
}
```

---

# 17. INITIAL STRATEGY

Start with one transparent strategy.

Example:

Trend Confirmation Strategy.

Indicators:

EMA 9

EMA 21

RSI 14

Volume SMA 20

ATR 14

Potential LONG:

EMA9 crosses above EMA21.

RSI within configured bullish range.

Volume exceeds threshold.

Price structure confirms trend.

Potential EXIT:

EMA trend reverses.

OR stop loss.

OR take profit.

Do not assume this particular strategy is profitable.

It is the initial strategy framework implementation.

---

# 18. STRATEGY VERSIONING

Critical.

Never modify strategy logic silently.

Versions:

trend-v1.0

trend-v1.1

trend-v2.0

Every signal and trade stores:

strategy_version

This allows comparison between algorithms.

---

# 19. AI ARCHITECTURE

AI should initially act as:

Market analyst.

News analyst.

Market-regime classifier.

Trade signal filter.

NOT unrestricted direct order generator.

Pipeline:

Market Data +
Technical Indicators +
News +
Market Context
↓
AI Analyzer
↓
Structured AI Decision
↓
Strategy Decision
↓
Risk Engine
↓
Execution

---

# 20. AI OPERATING MODES

## OFF

AI ignored completely.

Strategy → Risk Engine.

## ADVISORY

AI gives recommendations.

Bot does not use them when placing trades.

Useful for evaluating AI accuracy.

## FILTER

Strategy generates candidate trade.

AI can:

ALLOW

SKIP

REDUCE_RISK

AI cannot independently create a trade.

Recommended production starting mode.

## WEIGHTED

Technical score + AI score + sentiment score.

Example:

Technical = 74

AI market = 68

News = 59

Weighted:

Technical 60%

AI context 25%

News 15%

Final score calculated.

Trade only if threshold met.

---

# 21. AI MARKET INPUT

Do not send raw high-frequency data blindly.

Produce a structured snapshot.

Example:

```json
{
  "symbol": "BTCUSDT",
  "timestamp": "...",

  "price": {
    "current": 68210,
    "change_1h": 0.7,
    "change_24h": 2.1
  },

  "timeframes": {
    "5m": {
      "trend": "bullish",
      "rsi": 61,
      "atr": 220
    },

    "15m": {
      "trend": "bullish",
      "rsi": 57,
      "atr": 410
    },

    "1h": {
      "trend": "neutral",
      "rsi": 53
    }
  },

  "volume": {
    "relativeVolume": 1.42
  },

  "derivatives": {
    "fundingRate": 0.0001,
    "openInterestChange4h": 3.7
  }
}
```

---

# 22. AI OUTPUT CONTRACT

Never consume arbitrary AI prose for execution.

Require structured JSON.

Example:

```json
{
  "marketRegime": "BULLISH_TREND",

  "directionBias": "LONG",

  "confidence": 72,

  "riskLevel": "MEDIUM",

  "newsSentiment": 0.18,

  "recommendation": "ALLOW",

  "positionSizeModifier": 0.75,

  "reasons": [
    "15m and 5m trends are aligned",
    "relative volume is elevated",
    "news sentiment is mildly positive",
    "volatility is moderately elevated"
  ]
}
```

Validate against JSON Schema or Zod.

If invalid:

AI_RESULT_INVALID

Do not trade based on it.

---

# 23. MARKET REGIMES

AI classifier can identify:

BULLISH_TREND

BEARISH_TREND

SIDEWAYS

BREAKOUT

HIGH_VOLATILITY

LOW_VOLATILITY

PANIC

UNCERTAIN

Strategies can specify suitable regimes.

Example:

Trend Strategy:

Allowed:

BULLISH_TREND
BEARISH_TREND
BREAKOUT

Avoid:

SIDEWAYS

---

# 24. NEWS ENGINE

Separate service:

News Ingestion

Sources eventually:

Crypto news APIs

RSS

General financial news

Exchange announcements

Economic calendars

Official regulatory sources

Future:

X/social sentiment

Pipeline:

Feed
↓
Normalize
↓
Deduplicate
↓
Identify affected assets
↓
AI classify
↓
Sentiment score
↓
Impact score
↓
Store
↓
Aggregate

---

# 25. NEWS RECORD

Fields:

id

source

title

url

published_at

received_at

asset_tags

category

sentiment_score

impact_score

urgency

ai_summary

content_hash

---

# 26. NEWS CATEGORIES

MACRO

REGULATION

SECURITY

EXCHANGE

ETF

INSTITUTIONAL

TOKEN_SPECIFIC

PROTOCOL

HACK

LIQUIDATION

ECONOMIC_DATA

CENTRAL_BANK

MARKET_GENERAL

---

# 27. AI NEWS ANALYSIS

Example:

Headline:

Major exchange reports security incident.

AI result:

BTC relevance:
0.70

ETH relevance:
0.68

Sentiment:
-0.83

Importance:
0.91

Urgency:
HIGH

Category:
SECURITY

AI can therefore advise:

SKIP NEW LONG POSITIONS

without automatically liquidating positions.

---

# 28. AI PROVIDER ABSTRACTION

Do not hard-code OpenAI.

Create:

```ts
interface AIProvider {
  analyzeMarket(input: MarketAnalysisInput): Promise<MarketAnalysis>;

  analyzeNews(input: NewsAnalysisInput): Promise<NewsAnalysis>;
}
```

Implementations later:

OpenAI

Anthropic

Gemini

DeepSeek

Local model

User configuration can eventually choose provider/model.

Initially platform owner provides AI service.

---

# 29. AI COST CONTROL

Do NOT call AI on every ticker update.

Market data:

WebSocket continuously updates local state.

AI runs:

On candle close.

Example:

every 15 minutes.

AND:

when high-impact news arrives.

AND optionally:

before executing a candidate trade.

Cache analysis.

Example:

BTC 15m analysis can be shared internally as market context while keeping user-specific portfolio/risk decisions isolated.

---

# 30. MARKET DATA SERVICE

Use public Bybit WebSockets.

Responsibilities:

Subscribe to ticker.

Subscribe to candles.

Subscribe to trades if required.

Reconnect automatically.

Detect stale connection.

Persist selected candles.

Maintain latest price cache in Redis.

---

# 31. CANDLE EVENTS

Example:

BTCUSDT 15m candle closes.

Event:

market.candle.closed

Payload:

symbol

interval

open

high

low

close

volume

timestamp

Event consumers:

Indicator Service.

Strategy Engine.

AI Analysis Scheduler.

---

# 32. RISK ENGINE

No strategy or AI service can bypass the Risk Engine.

Pipeline:

Strategy Signal
↓
AI Filter
↓
RISK ENGINE
↓
APPROVE / REJECT
↓
Execution

Checks:

Bot enabled?

Live trading enabled?

Exchange connected?

Data fresh?

Capital available?

Allocation exceeded?

Already positioned?

Maximum daily loss exceeded?

Maximum drawdown exceeded?

Maximum trades exceeded?

Consecutive loss limit exceeded?

Stop-loss configured?

Position size valid?

Minimum exchange quantity satisfied?

Spread acceptable?

Slippage acceptable?

---

# 33. INITIAL RISK SETTINGS

For a $100 experimental bot, default configuration could be conservative.

Example:

Capital:

$100

Maximum trade:

$20

Maximum open positions:

1

Maximum daily loss:

$5

Maximum trades/day:

10

Maximum consecutive losing trades:

3

Default stop-loss:

Configurable.

Default take-profit:

Configurable.

These are configuration examples rather than promises of safety or profitability.

---

# 34. GLOBAL SAFETY CONTROLS

User-level:

STOP ALL BOTS

Platform-level:

GLOBAL EXECUTION STOP

Possible triggers:

Exchange outage.

Incorrect market data.

Database inconsistency.

Unexpected execution error.

API outage.

Abnormal duplicate-order behavior.

---

# 35. ORDER EXECUTION SERVICE

Only one service should be authorized to create orders.

Strategy workers must never call exchange APIs directly.

Architecture:

Strategy
↓
Signal
↓
Risk Engine
↓
Execution Queue
↓
Execution Service
↓
Bybit

---

# 36. IDEMPOTENCY

Every order must have an internally generated unique client identifier.

Example:

tenant_bot_timestamp_signal

Example:

usr37-bot8-1792410300-long-01

Map to Bybit's:

orderLinkId

Purpose:

avoid duplicate orders after:

timeouts.

worker restart.

network errors.

retry.

---

# 37. ORDER STATE MACHINE

INTERNAL_CREATED

SUBMITTING

SUBMITTED

NEW

PARTIALLY_FILLED

FILLED

CANCELLING

CANCELLED

REJECTED

FAILED

Do not assume order placement equals execution.

The exchange WebSocket is authoritative for reconciliation.

---

# 38. PRIVATE WEBSOCKET SERVICE

Each active exchange account needs private event handling.

Listen for:

Order changes.

Execution/fills.

Position updates.

Potential wallet/account changes.

Events update local database.

If WebSocket disconnects:

Reconnect.

Then reconcile via REST before resuming trading.

---

# 39. RECONCILIATION

Critical production feature.

Example:

Application restarts.

On startup:

Fetch open orders.

Fetch positions.

Fetch balances.

Compare with local database.

Resolve discrepancies.

Only then:

RUNNING

This prevents a restart from forgetting existing positions.

---

# 40. DATABASE

Recommended:

PostgreSQL.

Use Prisma or Drizzle.

Core tables:

users

accounts

sessions

workspaces

workspace_members

exchange_connections

bots

bot_configs

strategies

strategy_versions

market_candles

signals

ai_market_analysis

news_articles

news_analysis

risk_decisions

orders

order_events

executions

positions

trades

portfolio_snapshots

daily_performance

alerts

notifications

audit_logs

subscriptions

usage_records

---

# 41. IMPORTANT FOREIGN KEYS

Everything customer-specific should ultimately map to:

tenant_id

Example:

order

tenant_id
bot_id
exchange_connection_id
signal_id
risk_decision_id

This makes security enforcement easier.

---

# 42. ROW-LEVEL SECURITY

Strongly recommended.

PostgreSQL RLS can ensure:

User A cannot query User B's:

exchange account.

bot.

trade.

position.

API credentials.

analytics.

Even if application code contains a bug.

---

# 43. TRADE RECORD

Trade:

id

tenant_id

bot_id

symbol

direction

entry_time

entry_price

exit_time

exit_price

quantity

notional

gross_pnl

fees

funding

net_pnl

return_pct

strategy_version

ai_analysis_id

signal_id

status

---

# 44. SIGNAL LOG

Store every signal, including rejected ones.

Example:

BTCUSDT

Strategy:

LONG

Technical score:

76

AI:

ALLOW

AI confidence:

71

Risk:

REJECT

Reason:

MAX_DAILY_LOSS_REACHED

This is extremely valuable for debugging and strategy research.

---

# 45. USER DASHBOARD

Home screen:

Total connected exchange balance.

Allocated capital.

Active bots.

Today's P&L.

Total realized P&L.

Unrealized P&L.

Open positions.

Daily drawdown.

Win rate.

Recent trades.

AI market summary.

---

# 46. DASHBOARD EXAMPLE

AI Trading

Total Equity
$1,283.20

Bot Allocation
$300

Today's P&L
+$7.32

Open Positions
2

Active Bots
3

BTC Market
Bullish Trend

AI Confidence
72%

News Sentiment
+0.16

---

# 47. BOT CARD

BTC AI Bot

LIVE

BTCUSDT

15m

Capital:
$100

Equity:
$103.42

P&L:
+$3.42

Trades:
14

Win rate:
57%

Status:
RUNNING

AI:
FILTER

Buttons:

VIEW

PAUSE

STOP

---

# 48. BOT DETAIL

Tabs:

Overview

Positions

Trades

Signals

AI Analysis

News

Strategy

Risk

Configuration

Logs

Backtest

---

# 49. AI MARKET SCREEN

BTCUSDT

Market Regime:

BULLISH_TREND

Direction:

LONG

Confidence:

72%

Risk:

MEDIUM

News:

SLIGHTLY POSITIVE

Technical:

74/100

AI:

72/100

Combined:

73/100

Recommendation:

ALLOW LONG SIGNALS

Reasons displayed underneath.

---

# 50. TESTNET RESULTS

For each bot:

Initial Testnet Balance:

$100

Current simulated/account equity:

$102.13

PnL:

+$2.13

Return:

+2.13%

Trades:

9

Wins:

5

Losses:

4

Fees:

$0.46

Maximum drawdown:

-1.8%

The user should be able to reset a Testnet experiment.

---

# 51. BACKTESTING

Before live trading, allow users to run:

Pair:

BTCUSDT

Strategy:

Trend v1

Timeframe:

15m

Period:

30 days

Capital:

$100

AI:

OFF initially.

Later AI historical backtesting can be introduced carefully because historical news/context reconstruction is substantially more complicated.

---

# 52. PERFORMANCE METRICS

Track:

Starting equity.

Current equity.

Realized P&L.

Unrealized P&L.

Net return.

Gross profit.

Gross loss.

Fees.

Funding.

Win rate.

Loss rate.

Average win.

Average loss.

Profit factor.

Maximum drawdown.

Sharpe ratio.

Sortino ratio.

Expectancy.

Longest winning streak.

Longest losing streak.

Average trade duration.

Trades/day.

---

# 53. STRATEGY COMPARISON

Users should eventually compare:

Strategy Only

vs.

Strategy + AI Filter

Example:

Strategy only

Return:
+5.2%

Profit factor:
1.13

Drawdown:
-8.2%

Strategy + AI

Return:
+7.8%

Profit factor:
1.39

Drawdown:
-5.4%

This determines whether AI is actually providing value.

---

# 54. ALERTS

In-app notifications.

Optional:

Email.

Telegram.

Discord.

Mobile push later.

Alerts:

Bot started.

Bot stopped.

Trade opened.

Trade closed.

Stop loss triggered.

Take profit triggered.

Daily loss limit reached.

Exchange disconnected.

API credential error.

AI service unavailable.

Unexpected position detected.

---

# 55. AI FAILURE POLICY

AI failure must NOT stop core risk controls.

Example:

AI service unavailable.

If bot mode:

ADVISORY

Trading can continue strategy-only.

If:

FILTER

Configurable behavior:

FAIL CLOSED

Recommended.

Meaning:

No AI result → no new position.

Existing risk controls continue.

---

# 56. DATA-FRESHNESS POLICY

Every market snapshot stores:

received_at.

exchange_timestamp.

Before executing:

current time - market timestamp

must be below configured threshold.

If stale:

REJECT SIGNAL.

---

# 57. RATE LIMIT MANAGEMENT

Central exchange client.

Features:

Request limiter.

Retry policy.

Exponential backoff.

Rate-limit telemetry.

Circuit breaker.

Avoid REST polling where WebSocket provides appropriate events.

---

# 58. WORKER ARCHITECTURE

Recommended services:

Web App

API Server

Market Data Worker

Trading Worker

Execution Worker

AI Worker

News Worker

Scheduler

Notification Worker

For an initial small deployment they can remain in a monorepo and even run in fewer containers.

Later scale independently.

---

# 59. QUEUE SYSTEM

Redis + BullMQ is appropriate initially.

Queues:

market-events

strategy-evaluation

ai-analysis

risk-evaluation

order-execution

reconciliation

notifications

news-analysis

---

# 60. CONCURRENCY LOCKS

Prevent:

two workers trading the same bot simultaneously.

Use:

Redis distributed lock.

Example:

lock:

bot:{botId}:execution

Only one execution path may modify a bot's order state at any moment.

---

# 61. RECOMMENDED TECH STACK

Frontend:

Next.js

React

TypeScript

Tailwind CSS

shadcn/ui

Charts:

Lightweight Charts

or suitable financial charting library.

Backend:

Node.js

TypeScript

Fastify/NestJS or Next.js API initially.

ORM:

Prisma or Drizzle.

Database:

PostgreSQL.

Queue/cache:

Redis.

Workers:

BullMQ.

Validation:

Zod.

Authentication:

Better Auth / Auth.js / dedicated authentication framework.

Exchange:

Custom Bybit V5 adapter or maintained SDK wrapped behind your adapter.

AI:

Provider abstraction.

Deployment:

Docker.

---

# 62. MONOREPO

Recommended:

```text
trading-platform/

apps/

  web/
  api/
  worker/

packages/

  auth/

  db/

  exchange-core/

  exchange-bybit/

  market-data/

  indicators/

  strategies/

  risk-engine/

  execution-engine/

  ai-core/

  ai-providers/

  news/

  backtesting/

  notifications/

  shared/

  ui/

infra/

  docker/

  migrations/

  monitoring/
```

---

# 63. ENVIRONMENT CONFIGURATION

Example:

DATABASE_URL

REDIS_URL

APP_ENCRYPTION_KEY

AUTH_SECRET

AI_PROVIDER

AI_API_KEY

NEWS_PROVIDER_KEY

BYBIT_PUBLIC_API_URL

BYBIT_PUBLIC_WS_URL

LIVE_TRADING_PLATFORM_ENABLED

The platform itself should NOT have one universal user-trading API key.

Every exchange connection belongs to its user.

---

# 64. LIVE TRADING MASTER SWITCH

Environment:

LIVE_TRADING_PLATFORM_ENABLED=false

Development/staging:

false

Production:

true only when intentionally enabled.

Additionally each user must enable:

exchange live connection

AND:

bot live mode

AND:

acknowledge live trading.

Three independent controls.

---

# 65. OBSERVABILITY

Logging:

structured JSON.

Metrics:

API latency.

Exchange latency.

WebSocket status.

AI latency.

AI cost.

Queue lag.

Failed trades.

Rejected signals.

Rate limit events.

Database latency.

Monitoring:

Prometheus/Grafana later.

Initial:

application monitoring + centralized logs.

---

# 66. AUDIT LOG

Record sensitive actions:

User logged in.

Exchange connected.

Exchange disconnected.

API credential changed.

Bot created.

Bot modified.

Live mode enabled.

Bot started.

Bot stopped.

Risk settings changed.

Manual position action.

Admin action.

Audit records should be immutable from normal user interfaces.

---

# 67. ADMIN CONSOLE

Platform owner needs:

Users.

Active users.

Connected exchanges.

Active bots.

Testnet bots.

Live bots.

Trade volumes.

AI usage.

AI cost.

News usage.

Worker status.

Exchange status.

Errors.

Subscription status.

Revenue.

Do NOT expose users' decrypted exchange secrets to admins.

---

# 68. PLATFORM ADMIN SAFETY

Admin should be able to:

Disable platform trading globally.

Disable a malfunctioning strategy.

Disable an exchange connector.

Pause execution service.

Investigate errors.

Admin should NOT normally be able to:

Withdraw customer assets.

View API secrets.

Transfer customer crypto.

---

# 69. SUBSCRIPTION MODEL

Possible future business model:

FREE

1 bot

Testnet only

limited AI analysis

BASIC

3 bots

Live trading

AI analysis

PRO

10+ bots

Advanced strategies

Advanced analytics

priority AI analysis

API/webhook support

Could alternatively charge:

Monthly subscription.

Not profit sharing initially.

A simple SaaS subscription is operationally and legally cleaner than taking percentages of users' trading profits.

---

# 70. BILLING METRICS

Track:

active bots.

AI calls.

AI tokens.

news-analysis requests.

backtests.

connected exchanges.

monthly trade count.

Do not bill directly based on raw exchange account balance.

---

# 71. LEGAL / COMPLIANCE BOUNDARY

This becomes more important once other users can connect real accounts.

Design the product so:

Customer retains assets at their exchange.

Customer creates API credentials.

Customer chooses strategies.

Customer controls capital limits.

Customer can stop automation.

No withdrawal access.

No custody.

Clear risk disclosures.

Clear description that trading can lose money.

No guaranteed-return claims.

Before commercially launching automated live trading to third parties, obtain legal advice for the jurisdictions you serve.

The fact that users supply their own keys does not automatically mean every regulatory issue disappears.

---

# 72. EXCHANGE TERMS

Support only API usage permitted under the relevant exchange terms.

Users must connect accounts they are authorized to use.

Do not attempt to circumvent:

regional restrictions.

KYC restrictions.

product restrictions.

exchange controls.

The exchange adapter should surface these errors rather than trying to evade them.

---

# 73. SECURITY PRINCIPLES

Zero trust between tenants.

Least privilege.

No withdrawal APIs.

Encrypted API secrets.

IP restrictions where supported and practical.

Server-side trading only.

No API secret in browser.

Immutable audit trail.

2FA for sensitive actions.

Rate limiting.

Secret rotation.

Backup encryption.

Dependency scanning.

Container isolation.

---

# 74. USER DELETION

When a user deletes an exchange connection:

Stop dependent bots.

Cancel scheduled trading jobs.

Disconnect private WebSocket.

Remove active credential cache.

Delete encrypted API credentials according to retention policy.

Retain only regulatory/security audit records where legally appropriate.

---

# 75. PHASE 1 — MVP

Build:

Authentication.

Single-user workspace.

Bybit exchange integration.

User-specific encrypted API credentials.

Testnet/live connection.

BTCUSDT.

Spot initially.

One deterministic strategy.

Configurable capital.

Configurable trade size.

Stop-loss.

Take-profit.

Risk limits.

Market WebSocket.

Private WebSocket.

Order execution.

Order reconciliation.

Dashboard.

Trade history.

P&L.

Bot start/stop.

Audit logs.

---

# 76. PHASE 2 — AI

Add:

AI provider abstraction.

Market-context analysis.

Market-regime detection.

News ingestion.

News sentiment.

AI Advisory mode.

AI Filter mode.

AI explanation screen.

AI decision history.

Strategy vs Strategy+AI comparison.

---

# 77. PHASE 3 — ADVANCED TRADING

Add:

Multiple pairs.

Multiple strategies.

Multiple bots per user.

Portfolio-level exposure.

Advanced position sizing.

Trailing stop.

Break-even stop.

Limit entry.

DCA strategy.

Grid strategies where appropriate.

Derivatives only where the user's exchange/account/jurisdiction supports them.

---

# 78. PHASE 4 — PLATFORM

Add:

OKX.

Additional exchanges.

Subscriptions.

Organization accounts.

Roles.

More AI models.

Telegram notifications.

Mobile PWA.

Strategy marketplace.

Advanced backtesting.

Walk-forward testing.

Paper trading engine independent of exchange Testnet.

---

# 79. PHASE 5 — STRATEGY MARKETPLACE

Potential future feature.

Creators publish strategies.

Users subscribe.

Platform tracks:

strategy version.

historical results.

live verified results.

drawdown.

risk classification.

Never present backtested profit as guaranteed future performance.

---

# 80. INITIAL USER EXPERIENCE

The initial product should feel simple despite the sophisticated backend.

User signs in.

Dashboard says:

CONNECT YOUR EXCHANGE

User connects:

Bybit Testnet

Then:

CREATE YOUR FIRST BOT

Configuration:

Pair:

BTCUSDT

Capital:

$100

Trade size:

$20

Timeframe:

15m

Strategy:

Trend v1

AI:

Advisory

Stop Loss:

X%

Take Profit:

X%

Daily Loss Limit:

$5

Then:

START TESTNET BOT

---

# 81. FIRST-DAY USER EXPERIENCE

Dashboard:

BTCUSDT BOT

TESTNET

Starting Capital:

$100

Current Equity:

$101.28

Today's P&L:

+$1.28

Trades:

5

Wins:

3

Losses:

2

Current Signal:

WAIT

Technical Score:

61

AI Market Bias:

BULLISH

AI Confidence:

67%

News Sentiment:

NEUTRAL

Next Strategy Evaluation:

On next 15m candle close

---

# 82. LIVE TRANSITION

After testing, user can create a LIVE exchange connection.

Do not simply turn a Testnet API credential into Live.

Flow:

Connect Live Bybit account.

Validate.

Create/copy bot configuration.

Review:

Capital:

$100

Maximum trade:

$20

Maximum daily loss:

$5

Then explicitly:

ENABLE LIVE TRADING.

---

# 83. CRITICAL DESIGN RULE

A bot is not:

AI → Exchange

It is:

Market
↓
Strategy
↓
AI Context
↓
Risk Engine
↓
Execution Engine
↓
Exchange

The Risk Engine always has final veto power.

---

# 84. SECOND CRITICAL DESIGN RULE

The execution service does not care why an order exists.

It receives:

ApprovedOrderIntent

Example:

```ts
interface ApprovedOrderIntent {
  tenantId: string;
  botId: string;
  exchangeConnectionId: string;

  symbol: string;

  side: "BUY" | "SELL";

  orderType: "MARKET" | "LIMIT";

  quantity: string;

  limitPrice?: string;

  stopLoss?: string;

  takeProfit?: string;

  signalId: string;

  riskDecisionId: string;

  idempotencyKey: string;
}
```

Everything before that point is analysis.

Everything after it is deterministic financial execution.

---

# 85. THIRD CRITICAL DESIGN RULE

No cross-tenant credential sharing.

Never:

One Bybit API client shared with credentials dynamically overwritten.

Instead:

ExchangeConnection A
→ scoped adapter instance

ExchangeConnection B
→ scoped adapter instance

Credential loading happens server-side.

Secrets decrypted only when required.

Keep decrypted secrets in memory for the shortest practical period.

---

# 86. TARGET INITIAL DEPLOYMENT

For an MVP with a small number of users:

Reverse Proxy

Web/API container

Worker container

PostgreSQL

Redis

Optional news worker

Background AI worker

A modest VPS can run an early test deployment.

Once multiple users run live bots continuously, separate the trading/execution infrastructure from the web frontend.

Execution reliability is more important than frontend performance.

---

# 87. RECOMMENDED PRODUCTION SEPARATION

Eventually:

Public Web Server

        │
        ▼

API

        │

PostgreSQL / Redis

        │
        ▼

Private Trading Workers

        │
        ▼

Exchange APIs

The exchange API credentials should ideally only be accessible to the private trading/execution workers.

The public-facing web container should not require decrypted exchange secrets.

---

# 88. SUCCESS CRITERIA FOR MVP

MVP is successful when:

Two different users can register.

Both connect independent Bybit Testnet accounts.

Each creates a $100 bot.

Both bots run simultaneously.

Neither can access the other's information.

Market signals execute correctly.

Risk rules prevent oversized positions.

Orders reconcile correctly.

Restarting workers does not duplicate trades.

P&L matches exchange activity.

AI can analyze the same market while producing independently stored user/bot decisions.

Stopping one user's bot does not affect another user's bot.

Testnet and live credentials cannot be accidentally mixed.

No withdrawal access is required.

---

# 89. PRODUCT POSITIONING

The strongest positioning is not:

“AI bot that guarantees crypto profit.”

It should be:

“Build, test and automate your crypto trading strategy with AI market intelligence and strict risk controls.”

The platform gives users:

Automation.

Market intelligence.

News intelligence.

Repeatable strategies.

Risk management.

Testnet experimentation.

Analytics.

But never promises profitability.

---

# 90. INITIAL BUILD PRIORITY

Build in this order:

1. Authentication.
2. Multi-tenant database.
3. Exchange credential encryption.
4. Bybit connector.
5. Credential verification.
6. Market-data service.
7. Strategy engine.
8. Risk engine.
9. Order execution.
10. Private WebSocket.
11. Order reconciliation.
12. Bot lifecycle.
13. Dashboard.
14. P&L.
15. Testnet workflow.
16. Live-mode protection.
17. AI provider abstraction.
18. AI market analysis.
19. News ingestion.
20. AI Filter mode.
21. Notifications.
22. Backtesting.
23. Billing.
24. Additional exchanges.

This sequencing puts reliable trading infrastructure ahead of AI features.
