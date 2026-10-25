import type pg from "pg";
import { randomUUID } from "node:crypto";
import { type Candle } from "../../../packages/core/src/index.ts";
import {
  type AIProvider,
  errorCode,
  AIError,
} from "../../../packages/ai-core/src/index.ts";
import {
  aiStrategyConfig,
  aiTradeDecisionSchema,
  duration,
  indicatorValue,
  validateCandles,
  modelCatalog,
} from "../../../packages/trading/src/creator.ts";
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
import { runtimeConfiguration } from "../../api/src/installation.ts";
import { consume } from "../../api/src/platform.ts";
import { reserveCall } from "./intelligence.ts";
export async function aiStrategy(
  db: pg.PoolClient,
  tid: string,
  bot: any,
  candles: Candle[],
  position: { quantity: number; cost: number; direction?: string },
  now: number,
  providerOverride?: AIProvider,
) {
  const configuration = aiStrategyConfig.parse(bot.ai_strategy_config),
    ms = duration(bot.timeframe),
    candleTime = candles.at(-1)!.time;
  const input = {
    symbol: bot.symbol,
    marketType: bot.market_type ?? "SPOT",
    leverage: 1,
    marginMode: bot.market_type === "LINEAR" ? "ISOLATED" : null,
    interval: bot.timeframe,
    candleTime,
    price: candles.at(-1)!.close,
    indicators: Object.fromEntries(
      (
        [
          ["RSI", 14],
          ["EMA", 9],
          ["EMA", 21],
          ["MA", 20],
          ["MA", 50],
          ["VOLUME_RATIO", 20],
        ] as const
      ).map(([indicator, period]) => [
        `${indicator}${period}`,
        indicatorValue(candles, { indicator, period }),
      ]),
    ),
    candles: candles.slice(-30),
    position: {
      quantity: position.quantity,
      direction: position.direction ?? "LONG",
      averageEntry:
        position.quantity > 0 ? position.cost / position.quantity : null,
    },
    risk: {
      stopLossPct: bot.config.stopLossPct,
      takeProfitPct: bot.config.takeProfitPct,
      maxTrade: bot.config.maxTrade,
    },
  };
  const prior = (
    await db.query(
      "SELECT * FROM ai_strategy_decisions WHERE tenant_id=$1 AND bot_id=$2 AND candle_time=$3",
      [tid, bot.id, candleTime],
    )
  ).rows[0];
  if (
    prior &&
    (prior.model !== configuration.model ||
      prior.input?.interval !== bot.timeframe)
  )
    return {
      direction: "NONE" as const,
      reasons: ["AI_CONFIGURATION_CHANGED_WAIT_NEXT_CANDLE"],
      aiStrategyDecisionId: prior.id,
    };
  let record = prior;
  if (!record) {
    const settings = await runtimeConfiguration(db);
    const provider =
      providerOverride ??
      configuredProvider({ ...settings, AI_MODEL: configuration.model });
    let result = null,
      error: string | null = null,
      inputTokens = 0,
      outputTokens = 0;
    try {
      if (!validateCandles(candles, bot.timeframe, now))
        throw new AIError("AI_INPUT_STALE");
      if (!provider?.analyzeTrade) throw new AIError("AI_UNAVAILABLE");
      if (
        !providerOverride &&
        ![
          settings.AI_MODEL,
          ...(modelCatalog[settings.AI_PROVIDER ?? ""] ?? []),
        ].includes(configuration.model)
      )
        throw new AIError("AI_UNAVAILABLE");
      await consume(db, tid, "ai", `strategy:${bot.id}:${candleTime}`);
      const day = await reserveCall(db);
      const output = await provider.analyzeTrade(input);
      inputTokens = output.inputTokens;
      outputTokens = output.outputTokens;
      await db.query(
        "UPDATE ai_usage_daily SET input_tokens=input_tokens+$1,output_tokens=output_tokens+$2 WHERE day=$3",
        [
          Math.max(0, Math.floor(inputTokens)),
          Math.max(0, Math.floor(outputTokens)),
          day,
        ],
      );
      const parsed = aiTradeDecisionSchema.safeParse(output.value);
      if (!parsed.success) throw new AIError("AI_RESULT_INVALID");
      if (bot.market_type !== "LINEAR" && parsed.data.action === "SELL_SHORT")
        throw new AIError("AI_RESULT_INVALID");
      result = parsed.data;
      // Reject analysis that arrived after its decision window. Risk exits run independently.
      if (Date.now() >= candleTime + ms * 2)
        throw new AIError("AI_INPUT_STALE");
    } catch (e) {
      result = null;
      error =
        (e as Error).message === "MONTHLY_QUOTA_EXCEEDED"
          ? "AI_BUDGET_EXCEEDED"
          : errorCode(e);
    }
    record = {
      id: randomUUID(),
      result,
      status: result ? "VALID" : "FAILED",
      error_code: error,
    };
    await db.query(
      "INSERT INTO ai_strategy_decisions(id,tenant_id,bot_id,candle_time,provider,model,prompt_version,input,result,status,error_code,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,'ai-trade-v1.1',$7,$8,$9,$10,$11,$12)",
      [
        record.id,
        tid,
        bot.id,
        candleTime,
        provider?.id ?? "disabled",
        configuration.model,
        JSON.stringify(input),
        result ? JSON.stringify(result) : null,
        record.status,
        error,
        inputTokens,
        outputTokens,
      ],
    );
  }
  const valid =
    record.status === "VALID" &&
    now < candleTime + ms * 2 &&
    record.result?.confidence >= configuration.minConfidence;
  const direction =
    valid && record.result.action === "BUY" && position.quantity === 0
      ? "LONG"
      : valid && record.result.action === "EXIT" && position.quantity > 0
        ? "EXIT"
        : valid &&
            record.result.action === "SELL_SHORT" &&
            bot.market_type === "LINEAR" &&
            position.quantity === 0
          ? "SHORT"
          : "NONE";
  return {
    direction: direction as "LONG" | "SHORT" | "EXIT" | "NONE",
    reasons: [
      ...(record.status === "VALID" &&
      record.result?.confidence < configuration.minConfidence
        ? ["AI_CONFIDENCE_BELOW_THRESHOLD"]
        : []),
      ...(record.result?.reasons ?? [record.error_code ?? "AI_HOLD"]),
    ],
    aiStrategyDecisionId: record.id,
    aiAction: record.result?.action ?? "HOLD",
    confidence: record.result?.confidence ?? null,
  };
}
