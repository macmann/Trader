import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiGate,
  entryDecision,
  AIError,
  marketAnalysisSchema,
  buildMarketInput,
  contextKey,
  type MarketAnalysis,
  type AnalysisOutcome,
} from "../packages/ai-core/src/index.ts";
import {
  StructuredProvider,
  configuredProvider,
} from "../packages/ai-providers/src/index.ts";
import {
  parseFeed,
  normalizeUrl,
  fetchFeed,
  feeds,
} from "../packages/news/src/index.ts";
const valid: MarketAnalysis = {
  marketRegime: "BULLISH_TREND",
  directionBias: "LONG",
  confidence: 72,
  riskLevel: "MEDIUM",
  newsSentiment: 0.18,
  recommendation: "ALLOW",
  positionSizeModifier: 0.75,
  reasons: ["EMA trend aligns with supplied snapshot"],
};
const now = Date.now();
const outcome: AnalysisOutcome = {
  status: "VALID",
  result: valid,
  error: null,
  createdAt: now - 1000,
  expiresAt: now + 60000,
};
test("AI can never increase position sizing or accept invalid enum/prose/extra fields", () => {
  for (const value of [
    { ...valid, positionSizeModifier: 1.1 },
    { ...valid, confidence: 101 },
    { ...valid, confidence: NaN },
    { ...valid, recommendation: "BUY_NOW" },
    { ...valid, order: { qty: 1 } },
    "buy bitcoin",
  ])
    assert.equal(marketAnalysisSchema.safeParse(value).success, false);
});
test("OFF and ADVISORY preserve strategy decisions even during provider failure", () => {
  for (const mode of ["OFF", "ADVISORY"] as const) {
    assert.equal(aiGate(mode, "LONG", null).allowed, true);
    assert.equal(
      aiGate(mode, "LONG", {
        ...outcome,
        result: { ...valid, recommendation: "SKIP" },
      }).modifier,
      1,
    );
  }
});
test("FILTER fails closed for missing, failed, stale, future, and malformed analysis", () => {
  for (const o of [
    null,
    { ...outcome, status: "FAILED", error: "AI_TIMEOUT" },
    { ...outcome, expiresAt: now - 1 },
    { ...outcome, createdAt: now + 60000 },
    { ...outcome, result: { ...valid, positionSizeModifier: 2 } },
  ] as Array<AnalysisOutcome | null>)
    assert.equal(aiGate("FILTER", "LONG", o, now).allowed, false);
});
test("FILTER only reduces valid strategy entries and never creates or blocks exits", () => {
  assert.deepEqual(aiGate("FILTER", "LONG", outcome, now), {
    allowed: true,
    modifier: 0.75,
    reason: "AI_ALLOWED_ENTRY",
  });
  assert.equal(
    aiGate(
      "FILTER",
      "LONG",
      {
        ...outcome,
        result: {
          ...valid,
          recommendation: "REDUCE_RISK",
          positionSizeModifier: 0.9,
        },
      },
      now,
    ).modifier,
    0.5,
  );
  for (const mode of ["OFF", "ADVISORY", "FILTER"] as const)
    for (const direction of ["EXIT", "NONE"] as const)
      assert.equal(aiGate(mode, direction, null).allowed, true);
  for (const result of [
    { ...valid, recommendation: "SKIP" },
    { ...valid, marketRegime: "PANIC" },
    { ...valid, directionBias: "SHORT" },
    { ...valid, positionSizeModifier: 0 },
  ])
    assert.equal(
      aiGate(
        "FILTER",
        "LONG",
        { ...outcome, result: result as MarketAnalysis },
        now,
      ).allowed,
      false,
    );
});
test("market snapshot uses only closed candles and bounded indicators", () => {
  const last = Math.floor(now / 900000) * 900000 - 900000;
  const candles = Array.from({ length: 60 }, (_, i) => ({
    time: last - (59 - i) * 900000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 100 + i,
  }));
  const input = buildMarketInput(
    [...candles, { ...candles[59], time: last + 900000, close: 999999 }],
    [],
    now,
  );
  assert.equal(input.price, 160);
  assert.equal(input.candleTime, last);
  assert.ok(input.indicators.atr14 > 0);
  assert.throws(
    () =>
      buildMarketInput(
        candles.map((c) => ({ ...c, time: c.time - 3600000 })),
        [],
        now,
      ),
    /AI_INPUT_STALE/,
  );
  assert.throws(() => buildMarketInput([], [], now));
});
test("context identity includes model, provider and news but never requires tenant data", () => {
  const base = { id: "openai", model: "model-a" };
  assert.notEqual(
    contextKey(base, { price: 100 }),
    contextKey({ ...base, model: "model-b" }, { price: 100 }),
  );
  assert.notEqual(
    contextKey(base, { price: 100, news: [] }),
    contextKey(base, { price: 100, news: ["incident"] }),
  );
});
test("OpenAI adapter uses strict schema, validates payload, tracks usage, and excludes credentials from prompt", async () => {
  let captured: any;
  const transport: typeof fetch = async (url, init) => {
    captured = {
      url,
      body: JSON.parse(String(init?.body)),
      headers: init?.headers,
    };
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(valid) },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }),
      { status: 200 },
    );
  };
  const provider = new StructuredProvider(
    "openai",
    "test-model",
    "private-test-key",
    transport,
  );
  const result = await provider.analyzeMarket({
    symbol: "BTCUSDT",
    price: 100,
  } as any);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 30);
  assert.deepEqual(result.value, valid);
  assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured.body.response_format.json_schema.strict, true);
  assert.equal(
    JSON.stringify(captured.body).includes("private-test-key"),
    false,
  );
  assert.match(captured.body.messages[0].content, /untrusted/);
});
test("Anthropic adapter forces a structured tool and validates result", async () => {
  const provider = new StructuredProvider(
    "anthropic",
    "test-model",
    "key",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tool_choice.type, "tool");
      return new Response(
        JSON.stringify({
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", name: "market_analysis", input: valid },
          ],
          usage: { input_tokens: 25, output_tokens: 10 },
        }),
      );
    },
  );
  assert.deepEqual((await provider.analyzeMarket({} as any)).value, valid);
});
for (const [name, response, code] of [
  [
    "refusal",
    { choices: [{ finish_reason: "stop", message: { refusal: "No" } }] },
    "AI_RESULT_INVALID",
  ],
  [
    "truncated",
    {
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify(valid) },
        },
      ],
    },
    "AI_RESULT_INVALID",
  ],
  [
    "prose",
    { choices: [{ finish_reason: "stop", message: { content: "Buy now" } }] },
    "AI_RESULT_INVALID",
  ],
  [
    "bad size",
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({ ...valid, positionSizeModifier: 2 }),
          },
        },
      ],
    },
    "AI_RESULT_INVALID",
  ],
] as const)
  test(`provider rejects ${name}`, async () => {
    const provider = new StructuredProvider(
      "openai",
      "model",
      "key",
      async () => new Response(JSON.stringify(response)),
    );
    await assert.rejects(
      provider.analyzeMarket({} as any),
      (e: unknown) => e instanceof AIError && e.code === code,
    );
  });
test("provider HTTP and timeout failures expose bounded codes, never response secrets", async () => {
  for (const [status, code] of [
    [401, "AI_UNAVAILABLE"],
    [429, "AI_RATE_LIMITED"],
    [500, "AI_PROVIDER_ERROR"],
  ] as const) {
    const p = new StructuredProvider(
      "openai",
      "model",
      "key",
      async () => new Response("sensitive diagnostic", { status }),
    );
    await assert.rejects(
      p.analyzeMarket({} as any),
      (e: unknown) =>
        e instanceof AIError &&
        e.code === code &&
        !e.message.includes("sensitive"),
    );
  }
  const p = new StructuredProvider("openai", "model", "key", async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  await assert.rejects(p.analyzeMarket({} as any), /AI_TIMEOUT/);
  assert.equal(
    configuredProvider({ AI_PROVIDER: "openai", AI_MODEL: "model" }),
    null,
  );
  assert.equal(
    configuredProvider({
      AI_PROVIDER: "unsupported",
      AI_MODEL: "model",
      AI_API_KEY: "key",
    }),
    null,
  );
});
test("RSS parsing normalizes and deduplicates headlines, rejects unsafe links and DTD", () => {
  const date = new Date(now - 60000).toUTCString();
  const xml = `<rss><channel><item><title>BTC headline</title><link>https://example.com/story?utm_source=test</link><pubDate>${date}</pubDate></item><item><title>BTC duplicate</title><link>https://example.com/story</link><pubDate>${date}</pubDate></item><item><title>Unsafe</title><link>javascript:alert(1)</link><pubDate>${date}</pubDate></item></channel></rss>`;
  const articles = parseFeed(xml, "Fixture", now);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].url, "https://example.com/story");
  assert.equal(normalizeUrl("http://example.com"), null);
  assert.equal(normalizeUrl("https://user:pass@example.com"), null);
  assert.throws(
    () =>
      parseFeed(
        '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
        "Fixture",
      ),
    /NEWS_FEED_INVALID/,
  );
});
test("RSS rejects future/old items and enforces streamed size limit", async () => {
  const date = new Date(now + 3600000).toUTCString();
  assert.equal(
    parseFeed(
      `<rss><channel><item><title>Future</title><link>https://example.com</link><pubDate>${date}</pubDate></item></channel></rss>`,
      "Fixture",
      now,
    ).length,
    0,
  );
  await assert.rejects(
    fetchFeed(feeds[0], async () => new Response("x".repeat(1000001))),
    /NEWS_FEED_TOO_LARGE/,
  );
});

test("AI approval cannot overrule Risk Engine veto or turn NONE/EXIT into an entry", () => {
  assert.equal(
    entryDecision(
      "FILTER",
      "LONG",
      ["GLOBAL_STOP", "STALE_MARKET_DATA"],
      outcome,
      now,
    ).allowed,
    false,
  );
  assert.deepEqual(
    entryDecision("FILTER", "LONG", ["GLOBAL_STOP"], outcome, now).reasons,
    ["GLOBAL_STOP"],
  );
  assert.equal(
    entryDecision("ADVISORY", "LONG", ["ALLOCATION_EXCEEDED"], outcome, now)
      .allowed,
    false,
  );
  assert.equal(entryDecision("FILTER", "LONG", [], outcome, now).allowed, true);
  for (const direction of ["NONE", "EXIT"] as const)
    assert.equal(
      entryDecision("FILTER", direction, [], outcome, now).allowed,
      false,
    );
});

test("provider bounds response bytes before parsing", async () => {
  const provider = new StructuredProvider(
    "openai",
    "model",
    "key",
    async () => new Response("x".repeat(100001)),
  );
  await assert.rejects(provider.analyzeMarket({} as any), /AI_RESULT_INVALID/);
});

test("AI Strategy provider requests validated trade decisions with a dedicated prompt", async () => {
  let request: any;
  const provider = new StructuredProvider(
    "openai",
    "test-model",
    "fixture",
    async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  action: "EXIT",
                  confidence: 82,
                  reasons: ["Momentum weakened"],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    },
  );
  const result = await provider.analyzeTrade({
    symbol: "BTCUSDT",
    indicators: { rsi14: 30 },
    position: { quantity: 0.01 },
  });
  assert.equal(result.value.action, "EXIT");
  assert.match(request.messages[0].content, /BUY, HOLD or EXIT/);
  assert.equal(
    request.response_format.json_schema.schema.additionalProperties,
    false,
  );
});

test("market snapshots use the selected interval without incomplete candles or stale context", () => {
  for (const [timeframe, label] of [
    ["15", "15m"],
    ["30", "30m"],
    ["60", "1h"],
  ]) {
    const ms = Number(timeframe) * 60000,
      now = Math.floor(Date.now() / ms) * ms + 1000;
    const candles = Array.from({ length: 60 }, (_, i) => ({
      time: Math.floor(now / ms) * ms - (60 - i) * ms,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));
    const snapshot = buildMarketInput(
      [...candles, { ...candles[0], time: Math.floor(now / ms) * ms }],
      [],
      now,
      "BTCUSDT",
      timeframe,
    );
    assert.equal(snapshot.interval, label);
    assert.equal(snapshot.candleTime, candles.at(-1)!.time);
    assert.throws(() =>
      buildMarketInput(candles, [], now + ms, "BTCUSDT", timeframe),
    );
  }
});
