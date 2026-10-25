import { ema, type Candle } from "../../core/src/index.ts";
import { indicatorValue } from "./creator.ts";
export function marketDiagnostics(candles: Candle[], strategy: string) {
  if (candles.length < 51)
    return {
      indicators: null,
      conditions: [],
      note: "Insufficient candles for diagnostic indicators",
    };
  const last = candles.at(-1)!,
    previous = candles.at(-2)!;
  const indicators = Object.fromEntries(
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
  );
  const fast = ema(
      candles.map((c) => c.close),
      9,
    ),
    slow = ema(
      candles.map((c) => c.close),
      21,
    ),
    i = candles.length - 1;
  const volumeAverage =
    candles.slice(i - 20, i).reduce((sum, c) => sum + c.volume, 0) / 20;
  const conditions =
    strategy === "trend-v1.0"
      ? [
          {
            name: "EMA9 crosses above EMA21",
            passed: fast[i - 1] <= slow[i - 1] && fast[i] > slow[i],
            actual: {
              previousFast: fast[i - 1],
              previousSlow: slow[i - 1],
              fast: fast[i],
              slow: slow[i],
            },
          },
          {
            name: "RSI14 between 50 and 70",
            passed: indicators.RSI14 >= 50 && indicators.RSI14 <= 70,
            actual: indicators.RSI14,
          },
          {
            name: "Volume above previous 20-candle average",
            passed: last.volume > volumeAverage,
            actual: last.volume,
            threshold: volumeAverage,
          },
          {
            name: "Close above previous candle high",
            passed: last.close > previous.high,
            actual: last.close,
            threshold: previous.high,
          },
          {
            name: "Exit: EMA9 below EMA21",
            passed: fast[i] < slow[i],
            actual: { fast: fast[i], slow: slow[i] },
          },
        ]
      : [];
  return {
    indicators,
    conditions,
    candle: {
      time: last.time,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
    },
    note: "Diagnostic observations; execution still depends on the recorded strategy and risk decision",
  };
}
