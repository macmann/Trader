import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pool, tenant } from "../apps/api/src/db.ts";
import {
  analyzeBot,
  marketContext,
  reserveCall,
  closeIntelligence,
  ingestArticles,
  classifyHeadline,
  recentNews,
} from "../apps/worker/src/intelligence.ts";
import {
  AIError,
  type AIProvider,
  type MarketAnalysisInput,
  contextKey,
} from "../packages/ai-core/src/index.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
const users: string[] = [],
  tenants: string[] = [],
  contexts: string[] = [];
after(async () => {
  for (const tid of tenants) {
    for (const table of [
      "signals",
      "ai_analyses",
      "positions",
      "bots",
      "exchange_connections",
      "audit_logs",
    ])
      await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
    await admin.query("DELETE FROM workspaces WHERE id=$1", [tid]);
  }
  for (const id of users)
    await admin.query("DELETE FROM users WHERE id=$1", [id]);
  for (const id of contexts)
    await admin.query("DELETE FROM ai_market_contexts WHERE id=$1", [id]);
  await admin.end();
  await closeIntelligence();
  await pool.end();
});
async function fixture() {
  const uid = randomUUID(),
    tid = randomUUID(),
    cid = randomUUID(),
    bid = randomUUID();
  users.push(uid);
  tenants.push(tid);
  await admin.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
    [uid, `${uid}@example.com`, "fixture"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    uid,
  ]);
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Fixture','TESTNET','none','CONNECTED','{}')",
      [cid, tid],
    );
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,config,ai_mode) VALUES($1,$2,$3,'AI fixture','{}','FILTER')",
      [bid, tid, cid],
    );
  });
  return { tid, bid };
}
function input(): MarketAnalysisInput {
  return {
    symbol: "BTCUSDT",
    interval: "15m",
    candleTime: Math.floor(Date.now() / 900000) * 900000 - 900000,
    price: 100,
    indicators: {
      ema9: 101,
      ema21: 99,
      rsi14: 57,
      atr14: 3,
      relativeVolume: 1.4,
    },
    news: [],
  };
}
const value = {
  marketRegime: "BULLISH_TREND" as const,
  directionBias: "LONG" as const,
  confidence: 72,
  riskLevel: "MEDIUM" as const,
  newsSentiment: 0.1,
  recommendation: "ALLOW" as const,
  positionSizeModifier: 0.75,
  reasons: ["Validated fixture"],
};
test("shared market cache avoids repeat calls while per-tenant AI decisions remain isolated", async () => {
  const a = await fixture(),
    b = await fixture();
  let calls = 0;
  const provider: AIProvider = {
    id: "fixture",
    model: randomUUID(),
    analyzeMarket: async () => {
      calls++;
      return { value, inputTokens: 21, outputTokens: 13 };
    },
    analyzeNews: async () => {
      throw Error("not called");
    },
  };
  const snapshot = input();
  contexts.push(contextKey(provider, snapshot));
  const first = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "FILTER", snapshot, "LONG", true, provider),
  );
  const second = await tenant(b.tid, (db) =>
    analyzeBot(db, b.tid, b.bid, "ADVISORY", snapshot, "LONG", true, provider),
  );
  assert.equal(calls, 1);
  assert.notEqual(first.id, second.id);
  assert.equal(first.gate.modifier, 0.75);
  assert.equal(second.gate.modifier, 1);
  const repeated = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "FILTER", snapshot, "LONG", true, provider),
  );
  assert.equal(repeated.id, first.id);
  assert.equal(calls, 1);
  assert.equal(
    (
      await tenant(
        b.tid,
        async (db) =>
          (await db.query("SELECT * FROM ai_analyses WHERE id=$1", [first.id]))
            .rows,
      )
    ).length,
    0,
  );
  await assert.rejects(
    tenant(b.tid, async (db) => {
      await db.query(
        "INSERT INTO signals(id,tenant_id,bot_id,candle_time,strategy_version,data,decision,ai_analysis_id) VALUES($1,$2,$3,1,$4,$5,$6,$7)",
        [randomUUID(), b.tid, b.bid, "trend-v1.0", "{}", "{}", first.id],
      );
    }),
  );
  const cached = (
    await admin.query("SELECT * FROM ai_market_contexts WHERE id=$1", [
      contexts[0],
    ])
  ).rows[0];
  assert.equal(cached.input_tokens, 21);
  assert.equal(cached.output_tokens, 13);
  assert.equal(JSON.stringify(cached.input).includes(a.tid), false);
});
test("provider failure is persisted, cached, and fails Filter closed while Advisory proceeds", async () => {
  const a = await fixture();
  let calls = 0;
  const provider: AIProvider = {
    id: "fixture",
    model: randomUUID(),
    analyzeMarket: async () => {
      calls++;
      throw new AIError("AI_TIMEOUT");
    },
    analyzeNews: async () => {
      throw Error();
    },
  };
  const snapshot = input();
  contexts.push(contextKey(provider, snapshot));
  const filter = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "FILTER", snapshot, "LONG", true, provider),
  );
  const advisory = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "ADVISORY", snapshot, "LONG", true, provider),
  );
  assert.equal(calls, 1);
  assert.equal(filter.gate.allowed, false);
  assert.equal(advisory.gate.allowed, true);
  assert.equal(filter.outcome?.error, "AI_TIMEOUT");
  const history = await tenant(
    a.tid,
    async (db) =>
      (await db.query("SELECT * FROM ai_analyses WHERE bot_id=$1", [a.bid]))
        .rows,
  );
  assert.equal(history.length, 2);
  assert.ok(history.every((r) => r.status === "FAILED"));
});
test("OFF never invokes provider or persists AI records; missing provider remains explicit", async () => {
  const a = await fixture();
  const off = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "OFF", input(), "LONG", true, null),
  );
  assert.equal(off.id, null);
  assert.equal(off.gate.modifier, 1);
  const missing = await marketContext(input(), null);
  assert.equal(missing.error, "AI_UNAVAILABLE");
});
test("atomic daily call reservations stop at the configured cap", async () => {
  const db = await admin.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "INSERT INTO ai_usage_daily(day,calls) VALUES((now() AT TIME ZONE 'UTC')::date,0) ON CONFLICT(day) DO UPDATE SET calls=0",
    );
    await reserveCall(db, 2);
    await reserveCall(db, 2);
    await assert.rejects(reserveCall(db, 2), /AI_BUDGET_EXCEEDED/);
    await assert.rejects(reserveCall(db, 0), /AI_BUDGET_EXCEEDED/);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("cache-only worker path never calls a provider and waits for background context", async () => {
  const a = await fixture();
  let calls = 0;
  const provider: AIProvider = {
    id: "fixture",
    model: randomUUID(),
    analyzeMarket: async () => {
      calls++;
      return { value, inputTokens: 1, outputTokens: 1 };
    },
    analyzeNews: async () => {
      throw Error();
    },
  };
  const snapshot = input();
  contexts.push(contextKey(provider, snapshot));
  const pending = await tenant(a.tid, (db) =>
    analyzeBot(
      db,
      a.tid,
      a.bid,
      "FILTER",
      snapshot,
      "LONG",
      true,
      provider,
      true,
    ),
  );
  assert.equal(calls, 0);
  assert.equal(pending.id, null);
  assert.equal(pending.gate.allowed, false);
  assert.equal(pending.outcome?.error, "AI_BUSY");
  await marketContext(snapshot, provider);
  assert.equal(calls, 1);
  const ready = await tenant(a.tid, (db) =>
    analyzeBot(
      db,
      a.tid,
      a.bid,
      "FILTER",
      snapshot,
      "LONG",
      true,
      provider,
      true,
    ),
  );
  assert.equal(calls, 1);
  assert.ok(ready.id);
  assert.equal(ready.gate.allowed, true);
});

test("manual context and candidate decisions keep separate histories while reusing provider analysis", async () => {
  const a = await fixture();
  let calls = 0;
  const provider: AIProvider = {
    id: "fixture",
    model: randomUUID(),
    analyzeMarket: async () => {
      calls++;
      return { value, inputTokens: 1, outputTokens: 1 };
    },
    analyzeNews: async () => {
      throw Error();
    },
  };
  const snapshot = input();
  contexts.push(contextKey(provider, snapshot));
  const manual = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "FILTER", snapshot, "NONE", false, provider),
  );
  const candidate = await tenant(a.tid, (db) =>
    analyzeBot(db, a.tid, a.bid, "FILTER", snapshot, "LONG", true, provider),
  );
  assert.notEqual(manual.id, candidate.id);
  assert.equal(calls, 1);
  const rows = await tenant(
    a.tid,
    async (db) =>
      (
        await db.query("SELECT comparison FROM ai_analyses WHERE bot_id=$1", [
          a.bid,
        ])
      ).rows,
  );
  assert.equal(
    rows.filter(
      (r) => r.comparison.direction === "LONG" && r.comparison.strategyAllowed,
    ).length,
    1,
  );
});

test("news ingestion deduplicates and validated high-impact classification refreshes candle context", async () => {
  const db = await pool.connect(),
    id = randomUUID(),
    lowId = randomUUID(),
    asOf = Date.now() - 60000;
  const newsValue = {
    assetTags: ["BTC" as const],
    category: "SECURITY" as const,
    sentimentScore: -0.8,
    impactScore: 0.95,
    urgency: "HIGH" as const,
    summary: "A reported incident may affect market conditions.",
  };
  const provider: AIProvider = {
    id: "fixture",
    model: "fixture",
    analyzeMarket: async () => {
      throw Error();
    },
    analyzeNews: async () => ({
      value: newsValue,
      inputTokens: 10,
      outputTokens: 8,
    }),
  };
  try {
    const article = {
      id,
      source: "Fixture",
      title: "BTC incident",
      url: `https://example.com/${id}`,
      publishedAt: new Date(),
    };
    assert.equal(await ingestArticles(db, [article, article]), 1);
    await ingestArticles(db, [
      { ...article, id: lowId, url: `https://example.com/${lowId}` },
    ]);
    await classifyHeadline(
      db,
      { ...article, published_at: article.publishedAt },
      provider,
    );
    const stored = (
      await db.query("SELECT * FROM news_articles WHERE id=$1", [id])
    ).rows[0];
    assert.equal(stored.analysis_status, "VALID");
    assert.equal(stored.analysis.sentimentScore, -0.8);
    const context = await recentNews(db, asOf);
    assert.ok(context.some((n) => n.id === id && n.impact === 0.95));
    assert.ok(
      !context.some((n) => n.id === lowId),
      "new ordinary news waits for the next candle",
    );
    provider.analyzeNews = async () => {
      throw new AIError("AI_TIMEOUT");
    };
    await classifyHeadline(
      db,
      {
        id: lowId,
        title: article.title,
        source: article.source,
        published_at: article.publishedAt,
      },
      provider,
    );
    const failed = (
      await db.query("SELECT * FROM news_articles WHERE id=$1", [lowId])
    ).rows[0];
    assert.equal(failed.analysis_status, "FAILED");
    assert.equal(failed.error_code, "AI_TIMEOUT");
    assert.equal(failed.analysis, null);
  } finally {
    await db.query("DELETE FROM news_articles WHERE id=ANY($1)", [[id, lowId]]);
    db.release();
  }
});
