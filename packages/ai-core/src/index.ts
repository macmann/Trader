import { duration } from "../../trading/src/creator.ts";
import { symbolSchema, type Symbol } from "../../trading/src/index.ts";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ema, type Candle } from "../../core/src/index.ts";
export const PROMPT_VERSION = "market-news-v1.0";
export const aiMode = z.enum(["OFF", "ADVISORY", "FILTER"]);
export type AIMode = z.infer<typeof aiMode>;
export const marketAnalysisSchema = z.strictObject({
  marketRegime: z.enum([
    "BULLISH_TREND",
    "BEARISH_TREND",
    "SIDEWAYS",
    "BREAKOUT",
    "HIGH_VOLATILITY",
    "LOW_VOLATILITY",
    "PANIC",
    "UNCERTAIN",
  ]),
  directionBias: z.enum(["LONG", "SHORT", "NEUTRAL"]),
  confidence: z.number().int().min(0).max(100),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
  newsSentiment: z.number().min(-1).max(1),
  recommendation: z.enum(["ALLOW", "SKIP", "REDUCE_RISK"]),
  positionSizeModifier: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1).max(500)).min(1).max(8),
});
export type MarketAnalysis = z.infer<typeof marketAnalysisSchema>;
export const newsAnalysisSchema = z.strictObject({
  assetTags: z.array(z.enum(["BTC", "ETH", "SOL", "CRYPTO"])).max(4),
  category: z.enum([
    "MACRO",
    "REGULATION",
    "SECURITY",
    "EXCHANGE",
    "ETF",
    "INSTITUTIONAL",
    "TOKEN_SPECIFIC",
    "PROTOCOL",
    "HACK",
    "LIQUIDATION",
    "ECONOMIC_DATA",
    "CENTRAL_BANK",
    "MARKET_GENERAL",
  ]),
  sentimentScore: z.number().min(-1).max(1),
  impactScore: z.number().min(0).max(1),
  urgency: z.enum(["LOW", "MEDIUM", "HIGH"]),
  summary: z.string().min(1).max(1000),
});
export type NewsAnalysis = z.infer<typeof newsAnalysisSchema>;
export const marketInputSchema = z.strictObject({
  symbol: symbolSchema,
  candleTime: z.number().int().nonnegative(),
  interval: z.enum(["15m", "30m", "1h"]),
  price: z.number().positive(),
  indicators: z.strictObject({
    ema9: z.number().positive(),
    ema21: z.number().positive(),
    rsi14: z.number().min(0).max(100),
    atr14: z.number().nonnegative(),
    relativeVolume: z.number().nonnegative(),
  }),
  news: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string().max(400),
        publishedAt: z.string(),
        sentiment: z.number().min(-1).max(1).nullable(),
        impact: z.number().min(0).max(1).nullable(),
      }),
    )
    .max(10),
});
export type MarketAnalysisInput = z.infer<typeof marketInputSchema>;
export type NewsAnalysisInput = {
  title: string;
  source: string;
  publishedAt: string;
};
export type ProviderResult<T> = {
  value: T;
  inputTokens: number;
  outputTokens: number;
};
export interface AIProvider {
  id: string;
  model: string;
  analyzeMarket(
    input: MarketAnalysisInput,
  ): Promise<ProviderResult<MarketAnalysis>>;
  analyzeNews(input: NewsAnalysisInput): Promise<ProviderResult<NewsAnalysis>>;
  analyzeTrade?(
    input: unknown,
  ): Promise<
    ProviderResult<import("../../trading/src/creator.ts").AITradeDecision>
  >;
}
export class AIError extends Error {
  constructor(
    readonly code:
      | "AI_UNAVAILABLE"
      | "AI_RESULT_INVALID"
      | "AI_TIMEOUT"
      | "AI_RATE_LIMITED"
      | "AI_BUDGET_EXCEEDED"
      | "AI_PROVIDER_ERROR"
      | "AI_INPUT_STALE"
      | "AI_BUSY",
  ) {
    super(code);
    this.name = "AIError";
  }
}
export function errorCode(e: unknown): string {
  return e instanceof AIError ? e.code : "AI_PROVIDER_ERROR";
}
export function contextKey(
  provider: { id: string; model: string },
  input: unknown,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: provider.id,
        model: provider.model,
        prompt: PROMPT_VERSION,
        input,
      }),
    )
    .digest("hex");
}
export function buildMarketInput(
  candles: Candle[],
  news: MarketAnalysisInput["news"] = [],
  now = Date.now(),
  symbol: Symbol = "BTCUSDT",
  timeframe = "15",
): MarketAnalysisInput {
  const ms = duration(timeframe);
  const closed = candles.filter((c) => c.time + ms <= now);
  if (closed.length < 50) throw new AIError("AI_INPUT_STALE");
  const last = closed.at(-1)!;
  if (
    now - last.time >= ms * 2 ||
    closed.some(
      (c, i) =>
        ![c.time, c.open, c.close, c.high, c.low, c.volume].every(
          Number.isFinite,
        ) ||
        c.close <= 0 ||
        c.low <= 0 ||
        c.high < c.low ||
        c.volume < 0 ||
        (i > 0 && c.time - closed[i - 1].time !== ms),
    )
  )
    throw new AIError("AI_INPUT_STALE");
  const closes = closed.map((c) => c.close),
    i = closed.length - 1;
  let gains = 0,
    losses = 0,
    atr = 0;
  for (let j = i - 13; j <= i; j++) {
    const delta = closes[j] - closes[j - 1];
    gains += Math.max(0, delta);
    losses += Math.max(0, -delta);
    atr += Math.max(
      closed[j].high - closed[j].low,
      Math.abs(closed[j].high - closes[j - 1]),
      Math.abs(closed[j].low - closes[j - 1]),
    );
  }
  const avgVolume =
    closed.slice(i - 20, i).reduce((sum, c) => sum + c.volume, 0) / 20;
  return marketInputSchema.parse({
    symbol,
    candleTime: last.time,
    interval: timeframe === "60" ? "1h" : `${timeframe}m`,
    price: last.close,
    indicators: {
      ema9: ema(closes, 9).at(-1),
      ema21: ema(closes, 21).at(-1),
      rsi14:
        losses === 0
          ? gains === 0
            ? 50
            : 100
          : 100 - 100 / (1 + gains / losses),
      atr14: atr / 14,
      relativeVolume: avgVolume === 0 ? 0 : last.volume / avgVolume,
    },
    news,
  });
}
export type AnalysisOutcome = {
  status: "VALID" | "FAILED";
  result: MarketAnalysis | null;
  error: string | null;
  createdAt: number;
  expiresAt: number;
};
export function aiGate(
  mode: AIMode,
  direction: "LONG" | "EXIT" | "NONE",
  outcome: AnalysisOutcome | null,
  now = Date.now(),
): { allowed: boolean; modifier: number; reason: string } {
  if (direction !== "LONG")
    return { allowed: true, modifier: 1, reason: "AI_NOT_AN_ENTRY" };
  if (mode === "OFF") return { allowed: true, modifier: 1, reason: "AI_OFF" };
  if (mode === "ADVISORY")
    return { allowed: true, modifier: 1, reason: "AI_ADVISORY_ONLY" };
  if (!outcome || outcome.status !== "VALID" || !outcome.result)
    return {
      allowed: false,
      modifier: 0,
      reason: outcome?.error ?? "AI_UNAVAILABLE",
    };
  if (outcome.expiresAt <= now || outcome.createdAt > now + 5000)
    return { allowed: false, modifier: 0, reason: "AI_ANALYSIS_STALE" };
  const parsed = marketAnalysisSchema.safeParse(outcome.result);
  if (!parsed.success)
    return { allowed: false, modifier: 0, reason: "AI_RESULT_INVALID" };
  const r = parsed.data;
  if (
    r.recommendation === "SKIP" ||
    r.directionBias === "SHORT" ||
    r.marketRegime === "PANIC" ||
    r.marketRegime === "UNCERTAIN" ||
    r.positionSizeModifier === 0
  )
    return { allowed: false, modifier: 0, reason: "AI_SKIPPED_ENTRY" };
  return {
    allowed: true,
    modifier: Math.min(
      1,
      r.positionSizeModifier,
      r.recommendation === "REDUCE_RISK" ? 0.5 : 1,
    ),
    reason:
      r.recommendation === "REDUCE_RISK"
        ? "AI_REDUCED_RISK"
        : "AI_ALLOWED_ENTRY",
  };
}

export function entryDecision(
  mode: AIMode,
  direction: "LONG" | "EXIT" | "NONE",
  riskReasons: string[],
  outcome: AnalysisOutcome | null,
  now = Date.now(),
) {
  const gate = aiGate(mode, direction, outcome, now);
  return {
    allowed: direction === "LONG" && riskReasons.length === 0 && gate.allowed,
    modifier: gate.modifier,
    reasons:
      direction === "LONG" && !gate.allowed
        ? [...riskReasons, gate.reason]
        : [...riskReasons],
  };
}
