import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StructuredProvider,
  configuredProvider,
} from "../packages/ai-providers/src/index.ts";
const valid = {
  marketRegime: "UNCERTAIN",
  directionBias: "NEUTRAL",
  confidence: 10,
  riskLevel: "HIGH",
  newsSentiment: 0,
  recommendation: "SKIP",
  positionSizeModifier: 0,
  reasons: ["Insufficient market context"],
};
const input: any = {};
test("Gemini structured output uses a fixed endpoint, secret header and validated JSON contract", async () => {
  let seen: any;
  const p = new StructuredProvider("gemini", "gemini-test", "test-key", (async (
    url: any,
    init: any,
  ) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify(valid) }] },
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      }),
    );
  }) as typeof fetch);
  const result = await p.analyzeMarket(input);
  assert.equal(result.value.recommendation, "SKIP");
  assert.equal(result.inputTokens, 12);
  assert.equal(seen.init.headers["x-goog-api-key"], "test-key");
  assert.equal(seen.body.generationConfig.responseMimeType, "application/json");
  assert.ok(seen.url.startsWith("https://generativelanguage.googleapis.com/"));
  assert.ok(!seen.url.includes("test-key"));
  const invalid = new StructuredProvider(
    "gemini",
    "gemini-test",
    "test-key",
    (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: '{"createOrder":true}' }] },
            },
          ],
        }),
      )) as typeof fetch,
  );
  await assert.rejects(invalid.analyzeMarket(input), /AI_RESULT_INVALID/);
});
test("DeepSeek JSON output remains schema validated and cannot independently create an order", async () => {
  let seen: any;
  const p = new StructuredProvider("deepseek", "deepseek-test", "key", (async (
    url: any,
    init: any,
  ) => {
    seen = { url, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(valid) },
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 5 },
      }),
    );
  }) as typeof fetch);
  const r = await p.analyzeMarket(input);
  assert.equal(r.value.positionSizeModifier, 0);
  assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
  assert.equal(seen.body.response_format.type, "json_object");
  assert.ok(seen.body.messages[0].content.includes("JSON Schema"));
  assert.equal(
    configuredProvider({
      AI_PROVIDER: "gemini",
      AI_MODEL: "test",
      AI_API_KEY: "key",
    })?.id,
    "gemini",
  );
  assert.equal(
    configuredProvider({
      AI_PROVIDER: "deepseek",
      AI_MODEL: "test",
      AI_API_KEY: "key",
    })?.id,
    "deepseek",
  );
});
