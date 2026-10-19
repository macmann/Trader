import { consume } from "../../api/src/platform.ts";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { pool, tenant } from "../../api/src/db.ts";
import { BybitAdapter } from "../../../packages/core/src/index.ts";
import { buildMarketInput } from "../../../packages/ai-core/src/index.ts";
const intelligencePool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 2000,
  allowExitOnIdle: true,
});
export async function closeIntelligence() {
  await intelligencePool.end();
}
import {
  AIError,
  PROMPT_VERSION,
  contextKey,
  errorCode,
  marketAnalysisSchema,
  newsAnalysisSchema,
  aiGate,
  type AIMode,
  type AIProvider,
  type MarketAnalysisInput,
  type AnalysisOutcome,
  marketInputSchema,
} from "../../../packages/ai-core/src/index.ts";
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
import {
  fetchFeed,
  feeds,
  type Article,
} from "../../../packages/news/src/index.ts";
export function callLimit() {
  const n = Number(process.env.AI_MAX_CALLS_PER_DAY ?? 100);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : 0;
}
export async function reserveCall(db: pg.PoolClient, limit = callLimit()) {
  if (limit <= 0) throw new AIError("AI_BUDGET_EXCEEDED");
  const result = await db.query(
    "INSERT INTO ai_usage_daily(day,calls) VALUES((now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(day) DO UPDATE SET calls=ai_usage_daily.calls+1 WHERE ai_usage_daily.calls<$1 RETURNING day",
    [limit],
  );
  if (!result.rowCount) throw new AIError("AI_BUDGET_EXCEEDED");
  return result.rows[0].day;
}
async function usage(
  db: pg.PoolClient,
  day: unknown,
  input: number,
  output: number,
) {
  await db.query(
    "UPDATE ai_usage_daily SET input_tokens=input_tokens+$1,output_tokens=output_tokens+$2 WHERE day=$3",
    [Math.max(0, Math.floor(input)), Math.max(0, Math.floor(output)), day],
  );
}
export type ContextOutcome = AnalysisOutcome & {
  contextId: string | null;
  provider: string;
  model: string;
};
export async function marketContext(
  input: MarketAnalysisInput,
  provider: AIProvider | null = configuredProvider(),
  cacheOnly = false,
): Promise<ContextOutcome> {
  if (!provider)
    return {
      status: "FAILED",
      result: null,
      error: "AI_UNAVAILABLE",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30000,
      contextId: null,
      provider: "disabled",
      model: "none",
    };
  if (
    !marketInputSchema.safeParse(input).success ||
    Date.now() - input.candleTime >= 1800000 ||
    input.candleTime + 900000 > Date.now()
  )
    return {
      status: "FAILED",
      result: null,
      error: "AI_INPUT_STALE",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30000,
      contextId: null,
      provider: provider.id,
      model: provider.model,
    };
  const id = contextKey(provider, input);
  let db: pg.PoolClient;
  try {
    db = await intelligencePool.connect();
  } catch {
    return {
      status: "FAILED",
      result: null,
      error: "AI_BUSY",
      createdAt: Date.now(),
      expiresAt: Date.now() + 30000,
      contextId: null,
      provider: provider.id,
      model: provider.model,
    };
  }
  let locked = false;
  try {
    if (cacheOnly) {
      const cached = (
        await db.query(
          "SELECT * FROM ai_market_contexts WHERE id=$1 AND expires_at>now()",
          [id],
        )
      ).rows[0];
      if (!cached) throw new AIError("AI_BUSY");
      return {
        contextId: id,
        status: cached.status,
        result: cached.result
          ? marketAnalysisSchema.parse(cached.result)
          : null,
        error: cached.error_code,
        createdAt: cached.created_at.getTime(),
        expiresAt: cached.expires_at.getTime(),
        provider: provider.id,
        model: provider.model,
      };
    }
    locked = (
      await db.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        ["ai:" + id],
      )
    ).rows[0].locked;
    if (!locked) throw new AIError("AI_BUSY");
    const cached = (
      await db.query(
        "SELECT * FROM ai_market_contexts WHERE id=$1 AND expires_at>now()",
        [id],
      )
    ).rows[0];
    if (cached)
      return {
        contextId: id,
        status: cached.status,
        result: cached.result
          ? marketAnalysisSchema.parse(cached.result)
          : null,
        error: cached.error_code,
        createdAt: cached.created_at.getTime(),
        expiresAt: cached.expires_at.getTime(),
        provider: provider.id,
        model: provider.model,
      };
    let result = null,
      error: string | null = null,
      status: "VALID" | "FAILED" = "FAILED",
      inputTokens = 0,
      outputTokens = 0;
    const createdAt = Date.now();
    try {
      const day = await reserveCall(db);
      const output = await provider.analyzeMarket(input);
      await usage(db, day, output.inputTokens, output.outputTokens);
      inputTokens = output.inputTokens;
      outputTokens = output.outputTokens;
      const parsed = marketAnalysisSchema.safeParse(output.value);
      if (!parsed.success) throw new AIError("AI_RESULT_INVALID");
      result = parsed.data;
      status = "VALID";
    } catch (e) {
      error = errorCode(e);
    }
    const expiresAt =
      status === "VALID"
        ? Math.min(input.candleTime + 1800000, createdAt + 900000)
        : createdAt + 30000;
    await db.query(
      "INSERT INTO ai_market_contexts(id,provider,model,prompt_version,input,result,status,error_code,input_tokens,output_tokens,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET result=EXCLUDED.result,status=EXCLUDED.status,error_code=EXCLUDED.error_code,created_at=now(),expires_at=EXCLUDED.expires_at,input_tokens=EXCLUDED.input_tokens,output_tokens=EXCLUDED.output_tokens",
      [
        id,
        provider.id,
        provider.model,
        PROMPT_VERSION,
        JSON.stringify(input),
        result ? JSON.stringify(result) : null,
        status,
        error,
        inputTokens,
        outputTokens,
        new Date(expiresAt),
      ],
    );
    return {
      contextId: id,
      status,
      result,
      error,
      createdAt,
      expiresAt,
      provider: provider.id,
      model: provider.model,
    };
  } catch (e) {
    return {
      contextId: null,
      status: "FAILED",
      result: null,
      error: errorCode(e),
      createdAt: Date.now(),
      expiresAt: Date.now() + 30000,
      provider: provider.id,
      model: provider.model,
    };
  } finally {
    if (locked)
      await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        "ai:" + id,
      ]);
    db.release();
  }
}
export async function analyzeBot(
  db: pg.PoolClient,
  tenantId: string,
  botId: string,
  mode: AIMode,
  input: MarketAnalysisInput,
  direction: "LONG" | "EXIT" | "NONE",
  strategyAllowed: boolean,
  provider: AIProvider | null = configuredProvider(),
  cacheOnly = false,
) {
  if (mode === "OFF")
    return { id: null, outcome: null, gate: aiGate(mode, direction, null) };
  const inputHash = contextKey(provider ?? { id: "disabled", model: "none" }, {
    snapshot: input,
    direction,
    strategyAllowed,
  });
  const prior = (
    await db.query(
      "SELECT * FROM ai_analyses WHERE tenant_id=$1 AND bot_id=$2 AND candle_time=$3 AND input_hash=$4 AND mode=$5",
      [tenantId, botId, input.candleTime, inputHash, mode],
    )
  ).rows[0];
  if (prior) {
    const outcome: AnalysisOutcome = {
      status: prior.status,
      result: prior.result,
      error: prior.error_code,
      createdAt: prior.created_at.getTime(),
      expiresAt: prior.expires_at.getTime(),
    };
    return { id: prior.id, outcome, gate: aiGate(mode, direction, outcome) };
  }
  let quota = false;
  try {
    await consume(
      db,
      tenantId,
      "ai",
      `${botId}:${input.candleTime}:${inputHash}:${mode}`,
    );
  } catch (e) {
    if ((e as Error).message !== "MONTHLY_QUOTA_EXCEEDED") throw e;
    quota = true;
  }
  const outcome: ContextOutcome = quota
      ? {
          status: "FAILED",
          result: null,
          error: "AI_BUDGET_EXCEEDED",
          createdAt: Date.now(),
          expiresAt: Date.now() + 30000,
          contextId: null,
          provider: provider?.id ?? "disabled",
          model: provider?.model ?? "none",
        }
      : await marketContext(input, provider, cacheOnly),
    gate = aiGate(mode, direction, outcome),
    id = randomUUID();
  if (
    outcome.error === "AI_BUSY" &&
    (mode === "FILTER" || direction !== "LONG")
  )
    return { id: null, outcome, gate };
  const inserted = await db.query(
    "INSERT INTO ai_analyses(id,tenant_id,bot_id,candle_time,input_hash,context_id,mode,provider,model,prompt_version,status,result,error_code,comparison,expires_at,symbol) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(bot_id,candle_time,input_hash,mode) DO NOTHING RETURNING id",
    [
      id,
      tenantId,
      botId,
      input.candleTime,
      inputHash,
      outcome.contextId,
      mode,
      outcome.provider,
      outcome.model,
      PROMPT_VERSION,
      outcome.status,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.error,
      JSON.stringify({
        direction,
        strategyAllowed,
        strategyPlusFilterAllowed:
          strategyAllowed && aiGate("FILTER", direction, outcome).allowed,
        activeMode: mode,
        activeModeAllowed: strategyAllowed && gate.allowed,
        sizeModifier: gate.modifier,
        note: "Counterfactual signal decisions, not simulated or realized investment returns.",
      }),
      new Date(outcome.expiresAt),
      input.symbol,
    ],
  );
  if (!inserted.rowCount) {
    const prior = (
      await db.query(
        "SELECT * FROM ai_analyses WHERE tenant_id=$1 AND bot_id=$2 AND candle_time=$3 AND input_hash=$4 AND mode=$5",
        [tenantId, botId, input.candleTime, inputHash, mode],
      )
    ).rows[0];
    if (!prior) throw new AIError("AI_BUSY");
    const persisted: AnalysisOutcome = {
      status: prior.status,
      result: prior.result,
      error: prior.error_code,
      createdAt: prior.created_at.getTime(),
      expiresAt: prior.expires_at.getTime(),
    };
    return {
      id: prior.id,
      outcome: persisted,
      gate: aiGate(mode, direction, persisted),
    };
  }
  return { id, outcome, gate };
}
export async function recentNews(
  db: pg.PoolClient,
  asOf = Date.now(),
): Promise<MarketAnalysisInput["news"]> {
  const rows = (
    await db.query(
      "SELECT *,CASE WHEN analyzed_at<=$1 OR COALESCE((analysis->>'impactScore')::numeric,0)>=0.8 THEN analysis ELSE NULL END AS snapshot_analysis FROM news_articles WHERE published_at>($1::timestamptz-interval '24 hours') AND (received_at<=$1 OR COALESCE((analysis->>'impactScore')::numeric,0)>=0.8) ORDER BY published_at DESC,id LIMIT 10",
      [new Date(asOf)],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publishedAt: r.published_at.toISOString(),
    sentiment: r.snapshot_analysis?.sentimentScore ?? null,
    impact: r.snapshot_analysis?.impactScore ?? null,
  }));
}
export async function ingestArticles(db: pg.PoolClient, articles: Article[]) {
  let inserted = 0;
  for (const article of articles) {
    inserted +=
      (
        await db.query(
          "INSERT INTO news_articles(id,source,title,url,published_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            article.id,
            article.source,
            article.title,
            article.url,
            article.publishedAt,
          ],
        )
      ).rowCount ?? 0;
  }
  return inserted;
}
export async function classifyHeadline(
  db: pg.PoolClient,
  article: { id: string; title: string; source: string; published_at: Date },
  provider: AIProvider,
) {
  try {
    const day = await reserveCall(db),
      output = await provider.analyzeNews({
        title: article.title,
        source: article.source,
        publishedAt: article.published_at.toISOString(),
      });
    await usage(db, day, output.inputTokens, output.outputTokens);
    const parsed = newsAnalysisSchema.safeParse(output.value);
    if (!parsed.success) throw new AIError("AI_RESULT_INVALID");
    const result = parsed.data;
    await db.query(
      "UPDATE news_articles SET analysis=$1,analysis_status='VALID',provider=$2,model=$3,error_code=null,analyzed_at=now() WHERE id=$4",
      [JSON.stringify(result), provider.id, provider.model, article.id],
    );
  } catch (e) {
    await db.query(
      "UPDATE news_articles SET analysis_status='FAILED',error_code=$1,analyzed_at=now() WHERE id=$2",
      [errorCode(e), article.id],
    );
  }
}
let lastNews = 0;
export async function newsCycle(
  provider: AIProvider | null = configuredProvider(),
  force = false,
) {
  if (
    process.env.NEWS_ENABLED !== "true" ||
    !provider ||
    (!force && Date.now() - lastNews < 300000)
  )
    return;
  lastNews = Date.now();
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(72723250) AS locked"))
      .rows[0].locked;
    if (!locked) return;
    for (const feed of feeds) {
      try {
        await ingestArticles(db, await fetchFeed(feed));
      } catch {
        console.error(
          JSON.stringify({
            event: "NEWS_FEED_UNAVAILABLE",
            source: feed.source,
          }),
        );
      }
    }
    const pending = (
      await db.query(
        "SELECT * FROM news_articles WHERE (analysis_status='PENDING' OR (analysis_status='FAILED' AND analyzed_at<now()-interval '30 minutes')) AND published_at>now()-interval '24 hours' ORDER BY published_at DESC LIMIT 5",
      )
    ).rows;
    for (const article of pending)
      await classifyHeadline(db, article, provider);
  } finally {
    if (locked) await db.query("SELECT pg_advisory_unlock(72723250)");
    db.release();
  }
}

export async function warmAIContext(
  provider: AIProvider | null = configuredProvider(),
) {
  if (!provider) return;
  const workspaces = (await pool.query("SELECT id FROM workspaces")).rows;
  const activeSymbols = new Set<
    import("../../../packages/trading/src/index.ts").Symbol
  >();
  for (const workspace of workspaces) {
    for (const row of await tenant(
      workspace.id,
      async (db) =>
        (
          await db.query(
            "SELECT DISTINCT symbol FROM bots WHERE tenant_id=$1 AND ai_mode<>'OFF' AND status IN ('RUNNING','STARTING')",
            [workspace.id],
          )
        ).rows,
    ))
      activeSymbols.add(row.symbol);
  }
  for (const symbol of activeSymbols) {
    const candles = await new BybitAdapter("TESTNET").getCandles(symbol);
    const snapshot = buildMarketInput(candles, [], Date.now(), symbol);
    const db = await intelligencePool.connect();
    let news;
    try {
      news = await recentNews(db, snapshot.candleTime + 900000);
    } finally {
      db.release();
    }
    await marketContext(
      buildMarketInput(candles, news, Date.now(), symbol),
      provider,
    );
  }
}
