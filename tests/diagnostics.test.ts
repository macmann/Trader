import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeDiagnostics,
  redactDiagnostics,
} from "../apps/api/src/bot-diagnostics.ts";
import { marketDiagnostics } from "../packages/trading/src/diagnostics.ts";
import { readableDiagnostics } from "../apps/web/src/BotDiagnostics.tsx";
test("diagnostics distinguish no signal, rejected entry, and exit without a position", () => {
  const bot = { status: "RUNNING" },
    monitor = {
      checked_at: new Date(),
      snapshot: { stage: "WAITING_CANDLE", reasons: ["NEXT_CLOSED_CANDLE"] },
    },
    counts = { fills: 0, orders: 0 };
  const explain = (direction: string, reasons: string[] = []) =>
    summarizeDiagnostics(
      bot,
      monitor,
      [{ data: { direction }, decision: { approved: false, reasons } }],
      counts,
    ).join(" ");
  assert.match(explain("NONE"), /no entry or exit signal/);
  assert.match(
    explain("LONG", ["INSUFFICIENT_BALANCE"]),
    /INSUFFICIENT_BALANCE/,
  );
  assert.match(explain("EXIT"), /no bot-owned position/);
  assert.match(
    summarizeDiagnostics(bot, null, [], counts).join(" "),
    /No recent worker/,
  );
});
test("diagnostic export recursively removes sensitive fields and raw payloads", () => {
  const safe = redactDiagnostics({
    credentials: { apiSecret: "fixture" },
    events: [
      {
        apiKey: "fixture",
        reason: "WAIT",
        nested: { Authorization: "fixture", raw: { password: "fixture" } },
      },
    ],
    counts: { signals: 4 },
  });
  assert.deepEqual(safe, {
    events: [{ reason: "WAIT", nested: {} }],
    counts: { signals: 4 },
  });
});
test("trend diagnostics show numerical conditions without changing the strategy", () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({
    time: i * 900000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  const result = marketDiagnostics(candles, "trend-v1.0");
  assert.equal(result.indicators?.RSI14, 50);
  assert.equal(result.conditions.length, 5);
  assert.equal(result.conditions[0].passed, false);
  assert.equal(result.conditions[2].passed, false);
});
test("readable report includes findings, limits and complete exported log records", () => {
  const report = {
    generatedAt: "2026-10-25T00:00:00Z",
    bot: {
      id: "bot",
      name: "Example",
      status: "RUNNING",
      symbol: "BTCUSDT",
      timeframe: "15",
      strategy_version: "trend-v1.0",
    },
    window: { since: "2026-10-24T00:00:00Z" },
    summary: { findings: ["No entry signal"] },
    coverage: { history: "Limited history" },
    history: {
      signals: {
        total: 501,
        included: 500,
        truncated: true,
        records: [
          { decision: { approved: false, reasons: ["SPREAD_TOO_WIDE"] } },
        ],
      },
    },
  };
  const text = readableDiagnostics(report);
  assert.match(text, /TRUNCATED/);
  assert.match(text, /SPREAD_TOO_WIDE/);
  assert.match(text, /No entry signal/);
});
