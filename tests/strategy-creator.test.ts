import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rulesSchema,
  evaluateRules,
  indicatorValue,
  validateCandles,
  duration,
  aiTradeDecisionSchema,
} from "../packages/trading/src/creator.ts";
const candles = Array.from({ length: 120 }, (_, i) => ({
  time: i * 900000,
  open: i + 10,
  high: i + 12,
  low: i + 9,
  close: i + 11,
  volume: 100,
}));
test("creator validates bounded periods and evaluates numeric and indicator comparisons", () => {
  const rules = rulesSchema.parse({
    entry: [
      { left: { indicator: "RSI", period: 14 }, operator: "GT", right: 70 },
      {
        left: { indicator: "EMA", period: 9 },
        operator: "GT",
        right: { indicator: "MA", period: 21 },
      },
    ],
    exit: [
      { left: { indicator: "PRICE", period: 14 }, operator: "LT", right: 1 },
    ],
  });
  assert.equal(evaluateRules(rules, candles, false).direction, "LONG");
  assert.equal(evaluateRules(rules, candles, true).direction, "NONE");
  assert.equal(indicatorValue(candles, { indicator: "RSI", period: 14 }), 100);
  assert.equal(indicatorValue(candles, { indicator: "MA", period: 2 }), 129.5);
  assert.equal(
    indicatorValue(candles, { indicator: "VOLUME_RATIO", period: 20 }),
    1,
  );
  assert.throws(() => rulesSchema.parse({ ...rules, entry: [] }));
  assert.throws(() =>
    rulesSchema.parse({
      ...rules,
      entry: [
        { left: { indicator: "EMA", period: 101 }, operator: "GT", right: 5 },
      ],
    }),
  );
});
test("crossovers require a previous-to-current crossing and exits use their own rules", () => {
  const rule = {
    left: { indicator: "PRICE" as const, period: 2 },
    operator: "CROSS_ABOVE" as const,
    right: 130,
  };
  const rules = rulesSchema.parse({
    entry: [rule],
    exit: [{ ...rule, operator: "CROSS_BELOW" }],
  });
  const up = [
    ...candles,
    { ...candles.at(-1)!, time: 120 * 900000, close: 131 },
  ];
  assert.equal(evaluateRules(rules, candles, false).direction, "NONE");
  assert.equal(evaluateRules(rules, up, false).direction, "LONG");
  const down = [...up, { ...up.at(-1)!, time: 121 * 900000, close: 129 }];
  assert.equal(evaluateRules(rules, down, true).direction, "EXIT");
});
test("each interval rejects stale, gapped or invalid candles and arbitrary AI output", () => {
  for (const interval of ["5", "15", "30", "60", "240", "1440"]) {
    const ms = duration(interval),
      data = candles.map((c, i) => ({ ...c, time: i * ms }));
    assert.equal(validateCandles(data, interval, 120 * ms), true);
    assert.equal(validateCandles(data, interval, 121 * ms), false);
    assert.equal(
      validateCandles(
        data.slice(1).filter((_, i) => i !== 50),
        interval,
        120 * ms,
      ),
      false,
    );
  }
  for (const result of [
    "BUY",
    { action: "SELL_ALL", confidence: 90, reasons: ["test"] },
    { action: "BUY", confidence: 101, reasons: ["test"] },
    { action: "BUY", confidence: 90, reasons: ["test"], quantity: 999 },
  ])
    assert.equal(aiTradeDecisionSchema.safeParse(result).success, false);
});
