import { z } from "zod";
import { ema, type Candle } from "../../core/src/index.ts";
export const timeframeSchema = z.enum(["15", "30", "60"]);
export const duration = (interval: string) =>
  Number(timeframeSchema.parse(interval)) * 60000;
export const indicatorSchema = z.strictObject({
  indicator: z.enum(["RSI", "EMA", "MA", "PRICE", "VOLUME_RATIO"]),
  period: z.number().int().min(2).max(100).default(14),
});
const operand = z.union([
  z.number().finite().min(0).max(1e12),
  indicatorSchema,
]);
export const conditionSchema = z.strictObject({
  left: indicatorSchema,
  operator: z.enum(["GT", "LT", "CROSS_ABOVE", "CROSS_BELOW"]),
  right: operand,
});
export const rulesSchema = z.strictObject({
  entry: z.array(conditionSchema).min(1).max(10),
  exit: z.array(conditionSchema).min(1).max(10),
});
export type Rules = z.infer<typeof rulesSchema>;
export function indicatorValue(
  candles: Candle[],
  indicator: z.infer<typeof indicatorSchema>,
) {
  const { indicator: kind, period } = indicator;
  if (candles.length < period + 1) throw Error("INSUFFICIENT_CANDLES");
  const closes = candles.map((c) => c.close);
  if (kind === "PRICE") return closes.at(-1)!;
  if (kind === "EMA") return ema(closes, period).at(-1)!;
  if (kind === "MA")
    return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (kind === "VOLUME_RATIO") {
    const average =
      candles.slice(-period - 1, -1).reduce((a, b) => a + b.volume, 0) / period;
    return average > 0 ? candles.at(-1)!.volume / average : 0;
  }
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains += Math.max(d, 0);
    losses += Math.max(-d, 0);
  }
  return losses === 0
    ? gains === 0
      ? 50
      : 100
    : 100 - 100 / (1 + gains / losses);
}
export function validateCandles(
  candles: Candle[],
  interval: string,
  now: number,
) {
  const ms = duration(interval),
    last = candles.at(-1);
  return (
    candles.length >= 102 &&
    !!last &&
    last.time + ms <= now &&
    now - last.time < ms * 2 &&
    candles.every(
      (c, i) =>
        [c.time, c.open, c.high, c.low, c.close, c.volume].every(
          Number.isFinite,
        ) &&
        c.low > 0 &&
        c.open >= c.low &&
        c.open <= c.high &&
        c.close >= c.low &&
        c.close <= c.high &&
        c.volume >= 0 &&
        (i === 0 || c.time - candles[i - 1].time === ms),
    )
  );
}
export function evaluateRules(
  rules: Rules,
  candles: Candle[],
  positioned: boolean,
) {
  const list = positioned ? rules.exit : rules.entry;
  try {
    const checks: {
      rule: (typeof list)[number];
      left: number;
      right: number;
      passed: boolean;
      previousLeft?: number;
      previousRight?: number;
    }[] = [];
    const matched = list.map((rule) => {
      const value = (slice: Candle[], ref: typeof rule.right) =>
        typeof ref === "number" ? ref : indicatorValue(slice, ref);
      const left = indicatorValue(candles, rule.left),
        right = value(candles, rule.right);
      const record = (
        passed: boolean,
        previous?: { left: number; right: number },
      ) => {
        checks.push({
          rule,
          left,
          right,
          passed,
          ...(previous
            ? { previousLeft: previous.left, previousRight: previous.right }
            : {}),
        });
        return passed;
      };
      if (rule.operator === "GT") return record(left > right);
      if (rule.operator === "LT") return record(left < right);
      const previous = candles.slice(0, -1),
        a = indicatorValue(previous, rule.left),
        b = value(previous, rule.right);
      return record(
        rule.operator === "CROSS_ABOVE"
          ? a <= b && left > right
          : a >= b && left < right,
        { left: a, right: b },
      );
    });
    return {
      ruleChecks: checks,
      direction: matched.every(Boolean)
        ? ((positioned ? "EXIT" : "LONG") as "LONG" | "EXIT")
        : ("NONE" as const),
      reasons: matched.map(
        (yes, i) =>
          `${positioned ? "EXIT" : "ENTRY"}_RULE_${i + 1}_${yes ? "MATCH" : "WAIT"}`,
      ),
    };
  } catch {
    return { direction: "NONE" as const, reasons: ["INSUFFICIENT_CANDLES"] };
  }
}
export const aiStrategyConfig = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:/-]+$/),
  minConfidence: z.number().int().min(0).max(100).default(70),
});
export const aiTradeDecisionSchema = z.strictObject({
  action: z.enum(["BUY", "SELL_SHORT", "HOLD", "EXIT"]),
  confidence: z.number().int().min(0).max(100),
  reasons: z.array(z.string().min(1).max(500)).min(1).max(8),
});
export type AITradeDecision = z.infer<typeof aiTradeDecisionSchema>;
export const modelCatalog: Record<string, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4.1"],
  anthropic: ["claude-sonnet-4-20250514"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};
