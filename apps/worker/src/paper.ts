import { pool, tenant } from "../../api/src/db.ts";
import { OKXAdapter } from "../../../packages/exchanges/src/index.ts";
import {
  candleSeries,
  simulate,
} from "../../../packages/research/src/index.ts";
import type { Candle } from "../../../packages/core/src/index.ts";
// Public market data only: no exchange connection or credentials are loaded here.
export async function paperCycle(
  load: (symbol: string) => Promise<Candle[]> = (symbol) =>
    new OKXAdapter("TESTNET").getCandles(symbol),
  now = Date.now(),
) {
  const cache = new Map<string, Candle[]>();
  for (const w of (await pool.query("SELECT id FROM workspaces")).rows) {
    const sessions = await tenant(
      w.id,
      async (db) =>
        (
          await db.query(
            "SELECT id,symbol FROM paper_sessions WHERE tenant_id=$1 AND status='RUNNING' AND feed_mode='MARKET'",
            [w.id],
          )
        ).rows,
    );
    for (const s of sessions) {
      try {
        if (!cache.has(s.symbol))
          cache.set(
            s.symbol,
            candleSeries.parse(
              (await load(s.symbol)).filter((c) => c.time + 900000 <= now),
            ),
          );
        const batch = cache.get(s.symbol)!;
        if (!batch.length || now - batch.at(-1)!.time > 1800000) continue;
        await tenant(w.id, async (db) => {
          const p = (
            await db.query(
              "SELECT * FROM paper_sessions WHERE id=$1 AND tenant_id=$2 AND status='RUNNING' FOR UPDATE",
              [s.id, w.id],
            )
          ).rows[0];
          if (!p) return;
          const last = p.candles.at(-1)?.time ?? -1,
            newBars = batch.filter((c) => c.time > last);
          if (!newBars.length) return;
          if (
            p.candles.length + newBars.length > 5000 ||
            (last >= 0 && newBars[0].time !== last + 900000)
          ) {
            await db.query(
              "UPDATE paper_sessions SET status='STOPPED',revision=revision+1 WHERE id=$1 AND tenant_id=$2",
              [s.id, w.id],
            );
            await db.query(
              "INSERT INTO notifications(tenant_id,event_key,title) VALUES($1,$2,'PAPER FEED GAP OR HISTORY LIMIT') ON CONFLICT DO NOTHING",
              [w.id, "paper-limit:" + s.id],
            );
            return;
          }
          const candles = candleSeries.parse([...p.candles, ...newBars]),
            warmup = p.candles.length
              ? p.warmup_bars
              : newBars.filter((c) => c.time + 900000 <= p.created_at.getTime())
                  .length;
          const result = simulate(
            {
              symbol: p.symbol,
              strategyVersion: p.strategy_version,
              config: p.config,
              advancedConfig: p.advanced_config,
              settings: p.settings,
            },
            candles,
            warmup,
            false,
          );
          await db.query(
            "UPDATE paper_sessions SET candles=$1,result=$2,warmup_bars=$3,revision=revision+1 WHERE id=$4 AND tenant_id=$5",
            [
              JSON.stringify(candles),
              JSON.stringify(result),
              warmup,
              s.id,
              w.id,
            ],
          );
        });
      } catch {
        console.error(
          JSON.stringify({
            event: "PAPER_FEED_UNAVAILABLE",
            paperSessionId: s.id,
          }),
        );
      }
    }
  }
}
