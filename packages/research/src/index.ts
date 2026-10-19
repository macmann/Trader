import { createHash } from "node:crypto";
import { z } from "zod";
import { botConfig, type Candle } from "../../core/src/index.ts";
import {
  advancedConfig,
  strategySchema,
  symbolSchema,
  evaluateStrategy,
  protection,
  entryNotional,
  configurationVeto,
  type PositionState,
} from "../../trading/src/index.ts";
export const candleSchema = z
  .strictObject({
    time: z.number().int().nonnegative(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
  })
  .refine(
    (c) =>
      c.low <= Math.min(c.open, c.close) &&
      c.high >= Math.max(c.open, c.close) &&
      c.low <= c.high,
    "Invalid OHLC range",
  );
export const settingsSchema = z.strictObject({
  feeBps: z.number().min(0).max(100).default(10),
  slippageBps: z.number().min(0).max(100).default(5),
});
export const researchConfig = z
  .strictObject({
    symbol: symbolSchema.default("BTCUSDT"),
    strategyVersion: strategySchema.default("trend-v1.0"),
    config: botConfig,
    advancedConfig: advancedConfig.default(() => advancedConfig.parse({})),
    settings: settingsSchema.default(() => settingsSchema.parse({})),
  })
  .refine(
    (v) => !configurationVeto(v.strategyVersion, v.advancedConfig),
    "Invalid strategy configuration",
  );
export const candleSeries = z
  .array(candleSchema)
  .min(1)
  .max(5000)
  .superRefine((cs, ctx) => {
    for (let i = 1; i < cs.length; i++)
      if (cs[i].time - cs[i - 1].time !== 900000)
        ctx.addIssue({
          code: "custom",
          message:
            "Candles must be unique, ascending, contiguous 15-minute intervals",
          path: [i, "time"],
        });
  });
export type ResearchConfig = z.infer<typeof researchConfig>;
export type Fill = {
  time: number;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  fee: number;
  reason: string;
  netPnl?: number;
};
export function datasetHash(candles: Candle[]) {
  return createHash("sha256").update(JSON.stringify(candles)).digest("hex");
}
export function simulate(
  input: ResearchConfig,
  candles: Candle[],
  startIndex = 0,
  liquidate = true,
) {
  const { config: c, advancedConfig: a, settings: s } = input,
    fee = s.feeBps / 10000,
    slip = s.slippageBps / 10000;
  let cash = c.capital,
    qty = 0,
    cost = 0,
    peak = c.capital,
    maxDrawdown = 0,
    realized = 0,
    totalFees = 0,
    cycleNet = 0,
    losses = 0,
    day = "",
    dailyPnl = 0,
    dailyTrades = 0;
  let state: PositionState = {
    quantity: 0,
    cost: 0,
    highWatermark: 0,
    lastEntryPrice: 0,
    lastEntryAt: 0,
    entryCount: 0,
    gridLevelsFilled: [],
    lastExitPrice: 0,
  };
  let pending: {
    side: "BUY" | "SELL";
    budget: number;
    limit?: number;
    expires: number;
    reason: string;
    level?: number;
  } | null = null;
  const fills: Fill[] = [],
    cycles: number[] = [],
    equity: { time: number; value: number }[] = [];
  function sell(price: number, time: number, reason: string) {
    if (qty <= 0) return;
    const p = price * (1 - slip),
      gross = qty * p,
      f = gross * fee,
      net = gross - f - cost;
    cash += gross - f;
    totalFees += f;
    realized += net;
    cycleNet += net;
    fills.push({
      time,
      side: "SELL",
      price: p,
      quantity: qty,
      fee: f,
      reason,
      netPnl: net,
    });
    cycles.push(cycleNet);
    dailyPnl += net;
    losses = cycleNet < 0 ? losses + 1 : 0;
    qty = 0;
    cost = 0;
    cycleNet = 0;
    state = {
      quantity: 0,
      cost: 0,
      highWatermark: 0,
      lastEntryPrice: 0,
      lastEntryAt: 0,
      entryCount: 0,
      gridLevelsFilled: [],
      lastExitPrice: p,
    };
  }
  for (let i = startIndex; i < candles.length; i++) {
    const bar = candles[i],
      today = new Date(bar.time).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dailyPnl = 0;
      dailyTrades = 0;
    }
    if (qty > 0) {
      const atOpen = protection({
        price: bar.open,
        position: state,
        ...c,
        advanced: a,
      });
      if (atOpen.exit) {
        sell(bar.open, bar.time, atOpen.reason);
        pending = null;
      }
    }
    if (pending) {
      if (pending.expires < bar.time) pending = null;
      else if (pending.side === "SELL") {
        sell(bar.open, bar.time, pending.reason);
        pending = null;
      } else if (pending.limit === undefined || bar.low <= pending.limit) {
        const p =
            pending.limit === undefined
              ? bar.open * (1 + slip)
              : Math.min(bar.open, pending.limit),
          budget = Math.min(
            pending.budget,
            cash,
            Math.max(0, c.capital - cost),
          );
        const q = Math.floor((budget / (p * (1 + fee))) * 1e8) / 1e8,
          notional = q * p,
          f = notional * fee;
        if (q > 0 && notional >= 1) {
          qty += q;
          cost += notional + f;
          cash -= notional + f;
          totalFees += f;
          dailyTrades++;
          state.quantity = qty;
          state.cost = cost;
          state.lastEntryPrice = p;
          state.lastEntryAt = bar.time;
          state.entryCount++;
          state.highWatermark = Math.max(state.highWatermark, p);
          if (pending.level !== undefined)
            state.gridLevelsFilled!.push(pending.level);
          fills.push({
            time: bar.time,
            side: "BUY",
            price: p,
            quantity: q,
            fee: f,
            reason: pending.reason,
          });
        }
        pending = null;
      }
    }
    if (qty > 0) {
      const protect = protection({
        price: bar.open,
        position: state,
        ...c,
        advanced: a,
      });
      // If both bounds were touched, assume the adverse stop happened first. No intrabar high can tighten this bar's stop.
      if (bar.low <= protect.stopPrice) {
        sell(
          Math.min(bar.open, protect.stopPrice),
          bar.time,
          protect.reason === "TAKE_PROFIT" ? "STOP_LOSS" : protect.reason,
        );
        pending = null;
      } else if (bar.high >= protect.takeProfitPrice) {
        sell(
          Math.max(bar.open, protect.takeProfitPrice),
          bar.time,
          "TAKE_PROFIT",
        );
        pending = null;
      } else state.highWatermark = Math.max(state.highWatermark, bar.high);
    }
    const value = cash + qty * bar.close;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, ((peak - value) / peak) * 100);
    equity.push({ time: bar.time, value });
    const drawdown = ((peak - value) / peak) * 100;
    const signal = evaluateStrategy(
      input.strategyVersion,
      candles.slice(Math.max(0, i - 100), i + 1),
      state,
      a,
      bar.close,
      bar.time,
    );
    if (!pending && signal.direction === "EXIT" && qty > 0)
      pending = {
        side: "SELL",
        budget: 0,
        expires: Infinity,
        reason: signal.reasons.join(","),
      };
    const scale =
      input.strategyVersion === "dca-v1.0" ||
      input.strategyVersion.startsWith("grid-");
    if (
      !pending &&
      signal.direction === "LONG" &&
      (qty === 0 || scale) &&
      dailyPnl + Math.min(0, qty * bar.close - cost) > -c.dailyLoss &&
      drawdown < c.maxDrawdownPct &&
      dailyTrades < c.maxTrades &&
      losses < c.maxConsecutiveLosses
    ) {
      const budget = Math.min(
        entryNotional(c.capital, c.maxTrade, c.stopLossPct, a),
        cash,
        c.capital - cost,
      );
      if (budget >= 1)
        pending = {
          side: "BUY",
          budget,
          limit:
            a.entryType === "LIMIT"
              ? bar.close * (1 - a.limitOffsetPct / 100)
              : undefined,
          expires:
            a.entryType === "LIMIT"
              ? bar.time + a.limitTimeToLiveMinutes * 60000
              : Infinity,
          reason: signal.reasons.join(","),
          level: signal.level,
        };
    }
  }
  if (liquidate && qty > 0 && candles.length) {
    const last = candles.at(-1)!;
    sell(last.close, last.time, "END_OF_DATA");
    equity[equity.length - 1].value = cash;
    maxDrawdown = Math.max(maxDrawdown, ((peak - cash) / peak) * 100);
  }
  const last = candles.at(-1),
    ending = cash + qty * (last?.close ?? 0),
    wins = cycles.filter((n) => n > 0),
    negative = cycles.filter((n) => n < 0),
    profit = wins.reduce((s, n) => s + n, 0),
    loss = -negative.reduce((s, n) => s + n, 0);
  return {
    simulationOnly: true,
    verifiedLive: false,
    engineVersion: "spot-research-v1.0",
    startingEquity: c.capital,
    endingEquity: ending,
    netPnl: ending - c.capital,
    returnPct: (ending / c.capital - 1) * 100,
    maxDrawdownPct: maxDrawdown,
    fees: totalFees,
    realizedPnl: realized,
    unrealizedPnl: qty * (last?.close ?? 0) - cost,
    closedTrades: cycles.length,
    winRate: cycles.length ? (wins.length / cycles.length) * 100 : 0,
    profitFactor: loss ? profit / loss : null,
    cash,
    position: state,
    fills,
    equity,
    pending: pending
      ? {
          ...pending,
          expires: Number.isFinite(pending.expires) ? pending.expires : null,
        }
      : null,
  };
}
export function walkForward(
  input: ResearchConfig,
  candles: Candle[],
  candidates: z.infer<typeof advancedConfig>[],
  trainBars: number,
  testBars: number,
) {
  if (
    candidates.length < 1 ||
    candidates.length > 6 ||
    trainBars < 60 ||
    testBars < 15 ||
    candles.length < trainBars + testBars
  )
    throw Error("INVALID_WALK_FORWARD_WINDOWS");
  const folds = [];
  for (
    let start = 0;
    start + trainBars + testBars <= candles.length && folds.length < 8;
    start += testBars
  ) {
    const train = candles.slice(start, start + trainBars),
      test = candles.slice(
        start + trainBars - 60,
        start + trainBars + testBars,
      );
    const scores = candidates
      .map((a) => ({
        advancedConfig: a,
        result: simulate({ ...input, advancedConfig: a }, train),
      }))
      .sort(
        (a, b) =>
          b.result.returnPct -
          b.result.maxDrawdownPct -
          (a.result.returnPct - a.result.maxDrawdownPct),
      );
    const selected = scores[0];
    folds.push({
      trainStart: train[0].time,
      trainEnd: train.at(-1)!.time,
      testStart: test[60].time,
      testEnd: test.at(-1)!.time,
      selected: selected.advancedConfig,
      trainingScore: selected.result.returnPct - selected.result.maxDrawdownPct,
      outOfSample: simulate(
        { ...input, advancedConfig: selected.advancedConfig },
        test,
        60,
      ),
    });
  }
  return {
    simulationOnly: true,
    verifiedLive: false,
    selectionRule: "training return minus maximum drawdown",
    independentWindows: true,
    folds,
    meanOutOfSampleReturnPct:
      folds.reduce((s, f) => s + f.outOfSample.returnPct, 0) / folds.length,
  };
}
