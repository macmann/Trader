import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchConfig,
  candleSeries,
  simulate,
  walkForward,
  datasetHash,
} from "../packages/research/src/index.ts";
import { advancedConfig } from "../packages/trading/src/index.ts";
function candles(n = 80) {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 900000,
    open: 100,
    high: 100.1,
    low: 99.9,
    close: 100,
    volume: 100,
  }));
}
const config = researchConfig.parse({
  strategyVersion: "dca-v1.0",
  config: { capital: 100, maxTrade: 20, stopLossPct: 30, takeProfitPct: 50 },
  settings: { feeBps: 10, slippageBps: 5 },
});
test("research executes signals on the next bar, never at a known historical close", () => {
  const cs = candles(3);
  cs[1] = { ...cs[1], open: 110, high: 111, low: 109, close: 110 };
  cs[2] = { ...cs[2], open: 110, high: 111, low: 109, close: 110 };
  const result = simulate(config, cs, 0, false);
  assert.equal(result.fills[0].time, 900000);
  assert.equal(result.fills[0].side, "BUY");
  assert.ok(result.fills[0].price > 110);
  assert.equal(result.fills.filter((f) => f.side === "BUY").length, 1);
  const changed = [...cs];
  changed[2] = { ...changed[2], open: 120, high: 121, low: 119, close: 120 };
  assert.deepEqual(
    simulate(config, changed, 0, false).fills[0],
    result.fills[0],
  );
});
test("flat-price round trips include fees/slippage and reconcile ending equity to cash", () => {
  const r = simulate(config, candles());
  assert.ok(r.netPnl < 0);
  assert.ok(r.fees > 0);
  assert.ok(
    Math.abs(r.endingEquity - (r.startingEquity + r.realizedPnl)) < 1e-8,
  );
  assert.equal(r.position.quantity, 0);
  assert.equal(r.closedTrades, 1);
  assert.equal(r.simulationOnly, true);
  assert.equal(r.verifiedLive, false);
});
test("ambiguous OHLC paths assume stop loss before take profit", () => {
  const c = researchConfig.parse({
      strategyVersion: "dca-v1.0",
      config: { capital: 100, maxTrade: 20, stopLossPct: 2, takeProfitPct: 4 },
      settings: { feeBps: 0, slippageBps: 0 },
    }),
    cs = candles(2);
  cs[1] = { ...cs[1], high: 110, low: 95 };
  const r = simulate(c, cs);
  assert.equal(r.fills[1].reason, "STOP_LOSS");
  assert.equal(r.fills[1].price, 98);
  assert.ok(r.netPnl < 0);
});
test("limit entry expiry prevents fills and allocation remains bounded across DCA layers", () => {
  const limit = {
    ...config,
    advancedConfig: advancedConfig.parse({
      entryType: "LIMIT",
      limitTimeToLiveMinutes: 1,
    }),
  };
  assert.equal(simulate(limit, candles()).fills.length, 0);
  const cs = candles(30).map((c, i) => {
    const p = 100 - i;
    return { ...c, open: p, high: p + 0.1, low: p - 0.1, close: p };
  });
  const r = simulate(
    {
      ...config,
      advancedConfig: advancedConfig.parse({
        dcaIntervalMinutes: 15,
        dcaStepPct: 1,
        dcaMaxEntries: 20,
      }),
    },
    cs,
    0,
    false,
  );
  assert.ok(r.position.cost <= 100 + 1e-8);
  assert.ok(r.cash >= -1e-8);
  assert.ok(
    r.fills.every(
      (f) => f.side === "SELL" || f.price * f.quantity + f.fee <= 20 + 1e-8,
    ),
  );
});
test("walk-forward selections cannot see the future test window", () => {
  const cs = candles(120),
    candidates = [
      advancedConfig.parse({ dcaStepPct: 1 }),
      advancedConfig.parse({ dcaStepPct: 4 }),
    ];
  const a = walkForward(config, cs, candidates, 60, 30),
    changed = cs.map((c, i) =>
      i < 60 ? c : { ...c, open: 120, high: 121, low: 119, close: 120 },
    ),
    b = walkForward(config, changed, candidates, 60, 30);
  assert.deepEqual(a.folds[0].selected, b.folds[0].selected);
  assert.equal(a.folds[0].trainingScore, b.folds[0].trainingScore);
  assert.ok(a.folds[0].trainEnd < a.folds[0].testStart);
  assert.equal(a.independentWindows, true);
});
test("research rejects malformed, duplicate, missing and out-of-order candles", () => {
  const cs = candles(3);
  for (const bad of [
    [cs[0], cs[0]],
    [cs[1], cs[0]],
    [cs[0], cs[2]],
    [{ ...cs[0], low: 101 }],
  ])
    assert.equal(candleSeries.safeParse(bad).success, false);
  assert.equal(datasetHash(cs), datasetHash([...cs]));
  assert.notEqual(datasetHash(cs), datasetHash(cs.slice(1)));
});
