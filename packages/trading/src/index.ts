import { z } from "zod";
import { Decimal } from "decimal.js";
import { evaluate, type Candle } from "../../core/src/index.ts";
export const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
export const symbolSchema = z.enum(symbols);
export type Symbol = z.infer<typeof symbolSchema>;
export const strategies = [
  { id: "trend-v1.0", name: "Trend confirmation", execution: "DEVELOPMENT" },
  { id: "breakout-v1.0", name: "Volume breakout", execution: "DEVELOPMENT" },
  { id: "dca-v1.0", name: "Bounded DCA", execution: "DEVELOPMENT" },
  {
    id: "grid-accumulation-v1.0",
    name: "Grid accumulation (legacy)",
    execution: "DEVELOPMENT",
  },
  {
    id: "grid-accumulation-v1.1",
    name: "Grid accumulation with pullback",
    execution: "DEVELOPMENT",
  },
] as const;
export const strategySchema = z.enum([
  "trend-v1.0",
  "breakout-v1.0",
  "dca-v1.0",
  "grid-accumulation-v1.0",
  "grid-accumulation-v1.1",
]);
export type StrategyVersion = z.infer<typeof strategySchema>;
export const advancedConfig = z
  .strictObject({
    sizing: z.enum(["FIXED", "RISK_PERCENT"]).default("FIXED"),
    riskPerTradePct: z.number().positive().max(5).default(1),
    trailingStopPct: z.number().min(0).max(50).default(0),
    breakEvenTriggerPct: z.number().min(0).max(100).default(0),
    breakEvenOffsetPct: z.number().min(0).max(2).default(0),
    entryType: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
    limitTimeToLiveMinutes: z.number().int().min(1).max(1440).default(15),
    limitTimeInForce: z.enum(["GTC", "PostOnly"]).default("PostOnly"),
    limitOffsetPct: z.number().min(0).max(5).default(0.1),
    dcaStepPct: z.number().positive().max(50).default(2),
    dcaMaxEntries: z.number().int().min(1).max(20).default(3),
    dcaIntervalMinutes: z.number().int().min(15).max(10080).default(60),
    gridLower: z.number().positive().nullable().default(null),
    gridUpper: z.number().positive().nullable().default(null),
    gridLevels: z.number().int().min(2).max(20).default(5),
  })
  .refine(
    (v) =>
      !v.breakEvenTriggerPct || v.breakEvenOffsetPct < v.breakEvenTriggerPct,
    "Break-even offset must be below its trigger",
  );
export type AdvancedConfig = z.infer<typeof advancedConfig>;
export const portfolioLimits = z.strictObject({
  maxTotalAllocation: z.number().positive().max(10000000).default(1000),
  maxConnectionAllocation: z.number().positive().max(10000000).default(1000),
  maxSymbolAllocation: z.number().positive().max(10000000).default(1000),
  maxOpenPositions: z.number().int().min(1).max(100).default(5),
});
export type PortfolioLimits = z.infer<typeof portfolioLimits>;
export type PositionState = {
  quantity: number;
  cost: number;
  highWatermark: number;
  lastEntryPrice: number;
  lastEntryAt: number;
  entryCount: number;
  gridLevelsFilled?: number[];
  lastExitPrice?: number;
};
export function entryNotional(
  capital: number,
  maxTrade: number,
  stopLossPct: number,
  advanced: AdvancedConfig,
  modifier = 1,
): number {
  if (
    ![capital, maxTrade, stopLossPct, modifier].every(Number.isFinite) ||
    capital <= 0 ||
    maxTrade <= 0 ||
    stopLossPct <= 0 ||
    modifier < 0 ||
    modifier > 1
  )
    throw Error("INVALID_SIZING_INPUT");
  const target =
    advanced.sizing === "RISK_PERCENT"
      ? new Decimal(capital).mul(advanced.riskPerTradePct).div(stopLossPct)
      : new Decimal(maxTrade);
  return Decimal.min(target, maxTrade, capital)
    .mul(modifier)
    .toDecimalPlaces(8, Decimal.ROUND_DOWN)
    .toNumber();
}
export function protection(input: {
  price: number;
  position: PositionState;
  stopLossPct: number;
  takeProfitPct: number;
  advanced: AdvancedConfig;
}) {
  const { price, position: p, stopLossPct, takeProfitPct, advanced: a } = input;
  if (
    ![
      price,
      p.quantity,
      p.cost,
      p.highWatermark,
      stopLossPct,
      takeProfitPct,
    ].every(Number.isFinite) ||
    price <= 0 ||
    p.quantity < 0 ||
    p.cost < 0 ||
    stopLossPct <= 0 ||
    takeProfitPct <= 0
  )
    throw Error("INVALID_PROTECTION_INPUT");
  if (p.quantity === 0)
    return {
      entry: 0,
      highWatermark: 0,
      stopPrice: 0,
      takeProfitPrice: 0,
      exit: false,
      reason: "NO_POSITION",
    };
  const entry = p.cost / p.quantity;
  if (entry <= 0) throw Error("INVALID_POSITION_COST");
  const highWatermark = Math.max(entry, p.highWatermark, price);
  let stopPrice = entry * (1 - stopLossPct / 100),
    reason = "STOP_LOSS";
  if (a.trailingStopPct > 0) {
    const trailing = highWatermark * (1 - a.trailingStopPct / 100);
    if (trailing > stopPrice) {
      stopPrice = trailing;
      reason = "TRAILING_STOP";
    }
  }
  if (
    a.breakEvenTriggerPct > 0 &&
    highWatermark >= entry * (1 + a.breakEvenTriggerPct / 100)
  ) {
    const breakEven = entry * (1 + a.breakEvenOffsetPct / 100);
    if (breakEven > stopPrice) {
      stopPrice = breakEven;
      reason = "BREAK_EVEN_STOP";
    }
  }
  const takeProfitPrice = entry * (1 + takeProfitPct / 100);
  return {
    entry,
    highWatermark,
    stopPrice,
    takeProfitPrice,
    exit: price <= stopPrice || price >= takeProfitPrice,
    reason: price >= takeProfitPrice ? "TAKE_PROFIT" : reason,
  };
}
export function evaluateStrategy(
  version: StrategyVersion,
  candles: Candle[],
  state: PositionState,
  advanced: AdvancedConfig,
  price: number,
  now = Date.now(),
): { direction: "LONG" | "EXIT" | "NONE"; reasons: string[]; level?: number } {
  if (!Number.isFinite(price) || price <= 0)
    return { direction: "NONE", reasons: ["INVALID_PRICE"] };
  if (version === "trend-v1.0") return evaluate(candles);
  if (version === "breakout-v1.0") {
    if (candles.length < 21)
      return { direction: "NONE", reasons: ["INSUFFICIENT_CANDLES"] };
    const previous = candles.slice(-21, -1),
      latest = candles.at(-1)!,
      high = Math.max(...previous.map((c) => c.high)),
      low = Math.min(...previous.map((c) => c.low)),
      volume = previous.reduce((s, c) => s + c.volume, 0) / 20;
    if (latest.close < low)
      return { direction: "EXIT", reasons: ["BREAKOUT_RANGE_LOST"] };
    return latest.close > high && latest.volume > volume * 1.5
      ? {
          direction: "LONG",
          reasons: ["TWENTY_CANDLE_BREAKOUT", "VOLUME_ABOVE_150_PERCENT"],
        }
      : { direction: "NONE", reasons: ["WAIT_FOR_BREAKOUT"] };
  }
  if (version === "dca-v1.0") {
    if (state.entryCount >= advanced.dcaMaxEntries)
      return { direction: "NONE", reasons: ["DCA_ENTRY_LIMIT"] };
    if (state.quantity === 0)
      return { direction: "LONG", reasons: ["DCA_INITIAL_ENTRY"] };
    if (now - state.lastEntryAt < advanced.dcaIntervalMinutes * 60000)
      return { direction: "NONE", reasons: ["DCA_INTERVAL_NOT_REACHED"] };
    return price <= state.lastEntryPrice * (1 - advanced.dcaStepPct / 100)
      ? { direction: "LONG", reasons: ["DCA_PRICE_STEP_REACHED"] }
      : { direction: "NONE", reasons: ["WAIT_FOR_DCA_STEP"] };
  }
  const { gridLower: lower, gridUpper: upper, gridLevels: count } = advanced;
  if (lower === null || upper === null || upper <= lower)
    return { direction: "NONE", reasons: ["GRID_RANGE_REQUIRED"] };
  if (price < lower || price > upper)
    return { direction: "NONE", reasons: ["OUTSIDE_GRID_RANGE"] };
  const step = (upper - lower) / (count - 1),
    level = Math.min(count - 1, Math.floor((price - lower) / step));
  if (
    version === "grid-accumulation-v1.1" &&
    state.quantity === 0 &&
    (state.lastExitPrice ?? 0) > 0 &&
    price > (state.lastExitPrice ?? 0) - step
  )
    return { direction: "NONE", reasons: ["WAIT_FOR_GRID_CYCLE_PULLBACK"] };
  if (state.quantity > 0 && price >= state.cost / state.quantity + step)
    return { direction: "EXIT", reasons: ["GRID_PROFIT_RUNG_REACHED"] };
  if ((state.gridLevelsFilled ?? []).includes(level))
    return { direction: "NONE", reasons: ["GRID_LEVEL_ALREADY_FILLED"] };
  if (level === count - 1)
    return { direction: "NONE", reasons: ["GRID_TOP_RUNG_NO_ENTRY"] };
  return { direction: "LONG", reasons: ["GRID_ACCUMULATION_RUNG"], level };
}
export function exposureVeto(input: {
  limits: PortfolioLimits;
  total: number;
  connection: number;
  symbol: number;
  pending: number;
  openPositions: number;
  newNotional: number;
  alreadyPositioned: boolean;
  unknownPending: boolean;
}): string[] {
  if (
    [
      input.total,
      input.connection,
      input.symbol,
      input.pending,
      input.openPositions,
      input.newNotional,
    ].some((n) => !Number.isFinite(n) || n < 0)
  )
    return ["INVALID_PORTFOLIO_STATE"];
  const r: string[] = [];
  if (input.unknownPending) r.push("UNKNOWN_PENDING_EXPOSURE");
  if (
    new Decimal(input.total)
      .plus(input.newNotional)
      .gt(input.limits.maxTotalAllocation)
  )
    r.push("PORTFOLIO_EXPOSURE_LIMIT");
  if (
    new Decimal(input.connection)
      .plus(input.newNotional)
      .gt(input.limits.maxConnectionAllocation)
  )
    r.push("CONNECTION_EXPOSURE_LIMIT");
  if (
    new Decimal(input.symbol)
      .plus(input.newNotional)
      .gt(input.limits.maxSymbolAllocation)
  )
    r.push("SYMBOL_EXPOSURE_LIMIT");
  if (
    !input.alreadyPositioned &&
    input.openPositions >= input.limits.maxOpenPositions
  )
    r.push("PORTFOLIO_POSITION_LIMIT");
  return r;
}
export function planPreview(input: {
  strategy: StrategyVersion;
  advanced: AdvancedConfig;
  capital: number;
  maxTrade: number;
  stopLossPct: number;
  takeProfitPct: number;
  price: number;
  available: number;
  position: PositionState;
  candles: Candle[];
  limits: PortfolioLimits;
  exposure: {
    total: number;
    connection: number;
    symbol: number;
    pending: number;
    openPositions: number;
    unknownPending: boolean;
  };
  quantityStep: string;
  priceTick: string;
  minNotional: number;
  maxQuantity?: number;
  now?: number;
}) {
  const step = new Decimal(input.quantityStep),
    tick = new Decimal(input.priceTick);
  if (!step.isFinite() || step.lte(0) || !tick.isFinite() || tick.lte(0))
    throw Error("INVALID_INSTRUMENT_INCREMENT");
  const { advanced: a, position: p } = input,
    protect = protection({ ...input, advanced: a }),
    signal = protect.exit
      ? { direction: "EXIT" as const, reasons: [protect.reason] }
      : evaluateStrategy(
          input.strategy,
          input.candles,
          p,
          a,
          input.price,
          input.now,
        );
  const notional = entryNotional(
      input.capital,
      input.maxTrade,
      input.stopLossPct,
      a,
    ),
    limitPrice =
      a.entryType === "LIMIT"
        ? new Decimal(input.price)
            .mul(new Decimal(1).minus(new Decimal(a.limitOffsetPct).div(100)))
            .div(input.priceTick)
            .floor()
            .mul(input.priceTick)
            .toNumber()
        : null;
  const reference = limitPrice ?? input.price;
  if (reference <= 0) throw Error("INVALID_LIMIT_PRICE");
  const quantity = new Decimal(
      signal.direction === "EXIT"
        ? p.quantity
        : new Decimal(notional).div(reference),
    )
      .div(input.quantityStep)
      .floor()
      .mul(input.quantityStep),
    actualNotional = quantity.mul(reference).toNumber();
  const reasons: string[] = [];
  if (signal.direction === "LONG") {
    if (new Decimal(p.cost).plus(actualNotional).gt(input.capital))
      reasons.push("ALLOCATION_EXCEEDED");
    if (actualNotional > input.available) reasons.push("INSUFFICIENT_BALANCE");
    if (
      p.quantity > 0 &&
      ![
        "dca-v1.0",
        "grid-accumulation-v1.0",
        "grid-accumulation-v1.1",
      ].includes(input.strategy)
    )
      reasons.push("ALREADY_POSITIONED");
    reasons.push(
      ...exposureVeto({
        ...input.exposure,
        limits: input.limits,
        newNotional: actualNotional,
        alreadyPositioned: p.quantity > 0,
      }),
    );
  }
  if (
    signal.direction !== "NONE" &&
    (quantity.lte(0) || actualNotional < input.minNotional)
  )
    reasons.push("BELOW_EXCHANGE_MINIMUM");
  if (input.maxQuantity !== undefined && quantity.gt(input.maxQuantity))
    reasons.push("ABOVE_EXCHANGE_MAXIMUM");
  return {
    simulationOnly: true,
    orderSubmissionEnabled: false,
    strategyVersion: input.strategy,
    signal,
    protection: protect,
    proposal:
      signal.direction === "NONE"
        ? null
        : {
            side: signal.direction === "EXIT" ? "SELL" : "BUY",
            orderType: signal.direction === "EXIT" ? "MARKET" : a.entryType,
            quantity: quantity.toFixed(),
            limitPrice: signal.direction === "EXIT" ? null : limitPrice,
            notional: actualNotional,
          },
    risk: {
      approved: signal.direction !== "NONE" && reasons.length === 0,
      reasons,
    },
    notice:
      "Hypothetical planning only. This does not place, reserve, cancel, or fill an exchange order.",
  };
}
export function configurationVeto(
  strategy: StrategyVersion,
  advanced: AdvancedConfig,
): string | null {
  if (
    strategy.startsWith("grid-accumulation-") &&
    (advanced.gridLower === null ||
      advanced.gridUpper === null ||
      advanced.gridUpper <= advanced.gridLower)
  )
    return "GRID_RANGE_REQUIRED";
  return null;
}

export function instrumentVeto(
  quantity: string,
  price: number,
  filter: Record<string, unknown>,
  orderType: "MARKET" | "LIMIT" = "MARKET",
): string[] {
  try {
    const q = new Decimal(quantity),
      p = new Decimal(price),
      step = new Decimal(String(filter.basePrecision)),
      minValue = new Decimal(String(filter.minOrderAmt)),
      maxQty = new Decimal(
        String(
          (orderType === "LIMIT"
            ? filter.maxLimitOrderQty
            : filter.maxMarketOrderQty) ?? filter.maxOrderQty,
        ),
      );
    if (
      [q, p, step, maxQty].some((v) => !v.isFinite() || v.lte(0)) ||
      !minValue.isFinite() ||
      minValue.lt(0) ||
      (minValue.isZero() &&
        !(
          Number(filter.minOrderQty) > 0 &&
          Number.isFinite(Number(filter.minOrderQty))
        ))
    )
      return ["INVALID_INSTRUMENT_METADATA"];
    const reasons: string[] = [];
    if (!q.mod(step).isZero()) reasons.push("QUANTITY_STEP_MISMATCH");
    if (q.mul(p).lt(minValue)) reasons.push("BELOW_EXCHANGE_MINIMUM");
    if (q.gt(maxQty)) reasons.push("ABOVE_EXCHANGE_MAXIMUM");
    if (
      filter.minOrderQty !== undefined &&
      q.lt(new Decimal(String(filter.minOrderQty)))
    )
      reasons.push("BELOW_EXCHANGE_MINIMUM_QUANTITY");
    if (
      filter.maxOrderAmt !== undefined &&
      q.mul(p).gt(new Decimal(String(filter.maxOrderAmt)))
    )
      reasons.push("ABOVE_EXCHANGE_MAXIMUM_NOTIONAL");
    return reasons;
  } catch {
    return ["INVALID_INSTRUMENT_METADATA"];
  }
}
