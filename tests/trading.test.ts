import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advancedConfig,
  portfolioLimits,
  entryNotional,
  protection,
  evaluateStrategy,
  exposureVeto,
  planPreview,
  configurationVeto,
  symbolSchema,
  instrumentVeto,
} from "../packages/trading/src/index.ts";
const flat = {
  quantity: 0,
  cost: 0,
  highWatermark: 0,
  lastEntryPrice: 0,
  lastEntryAt: 0,
  entryCount: 0,
};
const held = {
  quantity: 1,
  cost: 100,
  highWatermark: 110,
  lastEntryPrice: 100,
  lastEntryAt: 0,
  entryCount: 1,
};
test("supported Spot symbols are explicit; derivatives and unknown pairs are rejected", () => {
  for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT"])
    assert.equal(symbolSchema.parse(s), s);
  assert.equal(symbolSchema.safeParse("BTCUSD-PERP").success, false);
});
test("risk-percent sizing honors stop distance, allocation, maximum trade and AI reduction", () => {
  const config = advancedConfig.parse({
    sizing: "RISK_PERCENT",
    riskPerTradePct: 1,
  });
  assert.equal(entryNotional(100, 100, 2, config), 50);
  assert.equal(entryNotional(100, 20, 2, config), 20);
  assert.equal(entryNotional(100, 100, 2, config, 0.5), 25);
  assert.equal(entryNotional(100, 100, 0.1, config), 100);
  assert.throws(() => entryNotional(100, 20, 0, config));
  assert.throws(() => entryNotional(100, 20, 2, config, 1.1));
});
test("trailing stop never loosens after a price retracement or restart", () => {
  const config = advancedConfig.parse({ trailingStopPct: 5 });
  const first = protection({
    price: 110,
    position: held,
    stopLossPct: 10,
    takeProfitPct: 30,
    advanced: config,
  });
  assert.equal(first.stopPrice, 104.5);
  const restored = protection({
    price: 106,
    position: { ...held, highWatermark: first.highWatermark },
    stopLossPct: 10,
    takeProfitPct: 30,
    advanced: config,
  });
  assert.equal(restored.stopPrice, 104.5);
  assert.equal(restored.exit, false);
  assert.equal(
    protection({
      price: 104,
      position: { ...held, highWatermark: first.highWatermark },
      stopLossPct: 10,
      takeProfitPct: 30,
      advanced: config,
    }).exit,
    true,
  );
});
test("break-even triggers from a persisted peak and does not undo a tighter trailing stop", () => {
  const config = advancedConfig.parse({
    breakEvenTriggerPct: 3,
    breakEvenOffsetPct: 0.2,
  });
  const state = protection({
    price: 101,
    position: { ...held, highWatermark: 104 },
    stopLossPct: 2,
    takeProfitPct: 10,
    advanced: config,
  });
  assert.equal(state.stopPrice, 100.2);
  assert.equal(state.reason, "BREAK_EVEN_STOP");
  assert.equal(
    protection({
      price: 100,
      position: { ...held, highWatermark: 104 },
      stopLossPct: 2,
      takeProfitPct: 10,
      advanced: config,
    }).exit,
    true,
  );
  const trailing = protection({
    price: 108,
    position: { ...held, highWatermark: 110 },
    stopLossPct: 2,
    takeProfitPct: 20,
    advanced: advancedConfig.parse({ ...config, trailingStopPct: 2 }),
  });
  assert.ok(trailing.stopPrice > 100.2);
  assert.equal(
    advancedConfig.safeParse({ breakEvenTriggerPct: 1, breakEvenOffsetPct: 1 })
      .success,
    false,
  );
});
test("versioned breakout needs range and volume confirmation and exits below range", () => {
  const candles = Array.from({ length: 21 }, (_, i) => ({
    time: i * 900000,
    open: 100,
    high: 101,
    low: 99,
    close: i === 20 ? 103 : 100,
    volume: i === 20 ? 200 : 100,
  }));
  assert.equal(
    evaluateStrategy(
      "breakout-v1.0",
      candles,
      flat,
      advancedConfig.parse({}),
      103,
    ).direction,
    "LONG",
  );
  candles[20].volume = 120;
  assert.equal(
    evaluateStrategy(
      "breakout-v1.0",
      candles,
      flat,
      advancedConfig.parse({}),
      103,
    ).direction,
    "NONE",
  );
  candles[20].close = 98;
  assert.equal(
    evaluateStrategy(
      "breakout-v1.0",
      candles,
      held,
      advancedConfig.parse({}),
      98,
    ).direction,
    "EXIT",
  );
});
test("bounded DCA enforces price step, interval, and entry count", () => {
  const config = advancedConfig.parse({
    dcaStepPct: 2,
    dcaMaxEntries: 3,
    dcaIntervalMinutes: 60,
  });
  assert.equal(
    evaluateStrategy("dca-v1.0", [], flat, config, 100, 7200000).direction,
    "LONG",
  );
  assert.equal(
    evaluateStrategy(
      "dca-v1.0",
      [],
      { ...held, lastEntryAt: 7000000 },
      config,
      97,
      7200000,
    ).direction,
    "NONE",
  );
  assert.equal(
    evaluateStrategy("dca-v1.0", [], held, config, 99, 7200000).direction,
    "NONE",
  );
  assert.equal(
    evaluateStrategy("dca-v1.0", [], held, config, 97, 7200000).direction,
    "LONG",
  );
  assert.equal(
    evaluateStrategy(
      "dca-v1.0",
      [],
      { ...held, entryCount: 3 },
      config,
      97,
      7200000,
    ).direction,
    "NONE",
  );
});
test("grid accumulation respects range, filled rungs and aggregate profit exit", () => {
  const config = advancedConfig.parse({
    gridLower: 80,
    gridUpper: 120,
    gridLevels: 5,
  });
  assert.equal(
    evaluateStrategy("grid-accumulation-v1.0", [], flat, config, 90).direction,
    "LONG",
  );
  assert.equal(
    evaluateStrategy(
      "grid-accumulation-v1.0",
      [],
      { ...flat, gridLevelsFilled: [1] },
      config,
      90,
    ).direction,
    "NONE",
  );
  assert.equal(
    evaluateStrategy("grid-accumulation-v1.0", [], flat, config, 79).direction,
    "NONE",
  );
  assert.equal(
    evaluateStrategy("grid-accumulation-v1.0", [], held, config, 111).direction,
    "EXIT",
  );
  assert.equal(
    configurationVeto("grid-accumulation-v1.0", advancedConfig.parse({})),
    "GRID_RANGE_REQUIRED",
  );
});
const exposure = {
  limits: portfolioLimits.parse({
    maxTotalAllocation: 100,
    maxConnectionAllocation: 80,
    maxSymbolAllocation: 60,
    maxOpenPositions: 2,
  }),
  total: 90,
  connection: 70,
  symbol: 50,
  pending: 10,
  openPositions: 1,
  newNotional: 10,
  alreadyPositioned: false,
  unknownPending: false,
};
test("portfolio ceilings include pending reservations and reject unknown exposure", () => {
  assert.deepEqual(exposureVeto(exposure), []);
  const rejected = exposureVeto({
    ...exposure,
    newNotional: 11,
    openPositions: 2,
    unknownPending: true,
  });
  assert.ok(rejected.includes("PORTFOLIO_EXPOSURE_LIMIT"));
  assert.ok(rejected.includes("CONNECTION_EXPOSURE_LIMIT"));
  assert.ok(rejected.includes("SYMBOL_EXPOSURE_LIMIT"));
  assert.ok(rejected.includes("PORTFOLIO_POSITION_LIMIT"));
  assert.ok(rejected.includes("UNKNOWN_PENDING_EXPOSURE"));
  assert.deepEqual(exposureVeto({ ...exposure, total: NaN }), [
    "INVALID_PORTFOLIO_STATE",
  ]);
});
test("limit/DCA preview rounds quantities down and never claims executable orders", () => {
  const result = planPreview({
    strategy: "dca-v1.0",
    advanced: advancedConfig.parse({ entryType: "LIMIT", limitOffsetPct: 1 }),
    capital: 100,
    maxTrade: 20,
    stopLossPct: 2,
    takeProfitPct: 4,
    price: 100,
    available: 100,
    position: flat,
    candles: [],
    limits: portfolioLimits.parse({}),
    exposure: {
      total: 0,
      connection: 0,
      symbol: 0,
      pending: 0,
      openPositions: 0,
      unknownPending: false,
    },
    quantityStep: "0.001",
    priceTick: "0.01",
    minNotional: 5,
  });
  assert.equal(result.simulationOnly, true);
  assert.equal(result.orderSubmissionEnabled, false);
  assert.equal(result.proposal?.orderType, "LIMIT");
  assert.equal(result.proposal?.limitPrice, 99);
  assert.equal(result.proposal?.quantity, "0.202");
  assert.ok(result.proposal!.notional <= 20);
  assert.equal(result.risk.approved, true);
});
test("DCA preview cannot exceed bot capital even with spare exchange funds", () => {
  const result = planPreview({
    strategy: "dca-v1.0",
    advanced: advancedConfig.parse({}),
    capital: 100,
    maxTrade: 20,
    stopLossPct: 10,
    takeProfitPct: 50,
    price: 97,
    available: 5000,
    position: { ...held, cost: 90, quantity: 0.9 },
    candles: [],
    limits: portfolioLimits.parse({}),
    exposure: {
      total: 90,
      connection: 90,
      symbol: 90,
      pending: 0,
      openPositions: 1,
      unknownPending: false,
    },
    quantityStep: "0.001",
    priceTick: "0.01",
    minNotional: 5,
    now: 7200000,
  });
  assert.equal(result.risk.approved, false);
  assert.ok(result.risk.reasons.includes("ALLOCATION_EXCEEDED"));
});

test("exchange metadata must bound minimums, maximums and quantity increments", () => {
  const filter = {
    basePrecision: "0.001",
    minOrderAmt: "5",
    maxMarketOrderQty: "10",
    minOrderQty: "0.01",
    maxOrderAmt: "500",
  };
  assert.deepEqual(instrumentVeto("0.2", 100, filter), []);
  assert.ok(
    instrumentVeto("0.2015", 100, filter).includes("QUANTITY_STEP_MISMATCH"),
  );
  assert.ok(
    instrumentVeto("0.001", 100, filter).includes("BELOW_EXCHANGE_MINIMUM"),
  );
  assert.ok(
    instrumentVeto("11", 100, filter).includes("ABOVE_EXCHANGE_MAXIMUM"),
  );
  assert.ok(
    instrumentVeto("6", 100, filter).includes(
      "ABOVE_EXCHANGE_MAXIMUM_NOTIONAL",
    ),
  );
  assert.deepEqual(
    instrumentVeto("0.2", 100, { basePrecision: "0.001", minOrderAmt: "5" }),
    ["INVALID_INSTRUMENT_METADATA"],
  );
});
