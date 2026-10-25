# Custom rules and AI Strategy

Custom rules execute Spot Testnet/Demo orders. AI Strategy supports Spot and isolated 1× USDT perpetuals through tenant-scoped accounting and execution checks; see [futures setup](futures.md). Live execution remains disabled.

## Create indicator rules

Open **Strategies**, name a strategy, and add entry and exit conditions. Supported indicators are RSI, EMA, MA (simple moving average), price, and volume ratio (current closed-candle volume divided by the previous period's average). Periods range from 2 to 100 candles; RSI uses rolling gains/losses over the selected period. EMA starts at the oldest supplied close; the worker fetches 200 candles. All entry conditions must match to buy; while positioned, all exit conditions must match to exit. Comparisons support greater/less than and crosses above/below a value or another indicator. Crossovers compare the previous and current completed candle.

For example: entry EMA 9 crosses above EMA 21, RSI 14 > 50, RSI 14 < 70; exit EMA 9 crosses below EMA 21. This is an example configuration, not a profitability claim.

Save the strategy, then choose **Custom indicator rules**, its saved version, and a **15-minute, 30-minute or 1-hour** candle interval when creating a bot. To revise rules, load a version and save a new version. Existing bots remain pinned to their selected version. Change a bot's version or interval in **Portfolio** after stopping it and clearing open exposure and unresolved orders. Signals and orders retain the exact custom-version identifier.

## Use AI Strategy

1. A platform administrator configures the AI provider, API key, default model and daily call budget in **Admin Settings**. Credentials remain encrypted in the database; no new environment variables are needed.
2. Create a bot, choose **AI Strategy**, select a model from the configured provider, a minimum confidence threshold, and the candle interval. Model availability still depends on the provider account; unsupported models fail closed and appear in monitoring. The configured default model and the built-in model choices are available; model catalogs do not imply provider access.
3. Configure capital, maximum trade, stop loss, take profit and loss limits. Start in Testnet/Demo.

Once per completed candle, the model receives closed candles, calculated RSI 14, EMA 9/21, MA 20/50, relative volume, bot-owned position and configured risk limits. It returns schema-validated BUY, HOLD or EXIT, confidence and reasons. BUY proposes a bounded entry only when flat; EXIT closes only the bot's tracked position. AI does not set arbitrary quantities, call exchange tools or bypass risk controls. The normal sizing configuration determines entry quantity.

Low confidence, unavailable providers, quota exhaustion, stale data or invalid responses produce no AI order. Failed analyses are recorded and not retried repeatedly within the same candle. Stop-loss/take-profit checks continue between candles and can exit without AI. These software checks require a healthy worker and exchange connection. Pause and Stop retain their existing behavior; they do not automatically liquidate positions.

Open the bot monitor's **Signals & risk** and **AI decisions** tabs to inspect decisions, model, indicator values and failures. Entries/exits and order history show actual exchange execution separately. AI Strategy uses its own configuration, rather than the separate Advisory/Filter setting. No provider calls occur from the browser.

Migration 010 adds immutable, tenant-isolated strategy versions and AI decision history. It runs during normal deployment migration. Historical backtesting/marketplace publication of these new modes is not available in this release; existing built-in strategy backtests remain supported.
