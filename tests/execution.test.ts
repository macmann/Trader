import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import pg from "pg";
import { pool, tenant } from "../apps/api/src/db.ts";
import { tick } from "../apps/worker/src/engine.ts";
import {
  BybitAdapter,
  botConfig,
  ExchangeError,
} from "../packages/core/src/index.ts";
import { advancedConfig } from "../packages/trading/src/index.ts";
import { portfolioSnapshot } from "../apps/api/src/portfolio.ts";
import { reconcile } from "../apps/worker/src/ledger.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
class Broker extends BybitAdapter {
  price = 100;
  creates = 0;
  cancels = 0;
  baseFees = false;
  loseAck = false;
  uncertainCancel = false;
  autoFill = true;
  orders = new Map<string, any>();
  fills: any[] = [];
  constructor() {
    super("TESTNET");
  }
  override async getInstrument(symbol: string) {
    return {
      list: [
        {
          symbol,
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: {
            basePrecision: "0.000001",
            minOrderQty: "0.000001",
            minOrderAmt: "1",
            maxMarketOrderQty: "100000",
            maxLimitOrderQty: "100000",
            maxOrderAmt: "1000000",
          },
        },
      ],
    };
  }
  override async getTicker(_symbol: string) {
    return {
      list: [
        {
          lastPrice: String(this.price),
          bid1Price: String(this.price - 0.1),
          ask1Price: String(this.price + 0.1),
        },
      ],
    };
  }
  override async getCandles(_symbol: string) {
    const last = Math.floor(Date.now() / 900000) * 900000 - 900000;
    return Array.from({ length: 60 }, (_, i) => ({
      time: last - (59 - i) * 900000,
      open: this.price,
      high: this.price + 1,
      low: this.price - 1,
      close: this.price,
      volume: 100,
    }));
  }
  override async getBalances() {
    let cash = new Decimal(1000);
    const assets: Record<string, Decimal> = {};
    for (const f of this.fills) {
      const o = this.orders.get(f.orderLinkId),
        base = o.symbol.replace(/USDT$/, ""),
        q = new Decimal(f.execQty),
        p = new Decimal(f.execPrice),
        fee = new Decimal(f.execFee),
        baseFee = f.feeCurrency === base ? fee : new Decimal(0);
      assets[base] ??= new Decimal(0);
      assets[base] = assets[base].plus(
        o.side === "Buy" ? q.minus(baseFee) : q.plus(baseFee).neg(),
      );
      cash = cash
        .plus(q.mul(p).mul(o.side === "Buy" ? -1 : 1))
        .minus(f.feeCurrency === "USDT" ? fee : 0);
    }
    return {
      list: [
        {
          coin: [
            { coin: "USDT", walletBalance: cash.toFixed() },
            ...Object.entries(assets).map(([coin, value]) => ({
              coin,
              walletBalance: value.toFixed(),
            })),
          ],
        },
      ],
    };
  }
  override async getOpenOrders(_cursor?: string) {
    return {
      list: [...this.orders.values()].filter((o) =>
        ["New", "PartiallyFilled"].includes(o.orderStatus),
      ),
    };
  }
  override async getExecutions(
    _cursor?: string,
    _start?: number,
    _end?: number,
  ) {
    return { list: [...this.fills].reverse() };
  }
  override async getOrder(client: string) {
    return { list: this.orders.has(client) ? [this.orders.get(client)] : [] };
  }
  override async placeOrder(p: Parameters<BybitAdapter["placeOrder"]>[0]) {
    this.creates++;
    if (this.orders.has(p.orderLinkId))
      throw new ExchangeError(10014, "DUPLICATE");
    const order = {
      ...p,
      orderId: randomUUID(),
      orderStatus: "New",
      cumExecQty: "0",
    };
    this.orders.set(p.orderLinkId, order);
    if (p.orderType !== "Limit" && this.autoFill) this.fill(p.orderLinkId);
    if (this.loseAck) {
      this.loseAck = false;
      throw Error("ACK_LOST");
    }
    return { orderId: order.orderId };
  }
  override async cancelOrder(_symbol: string, id: string) {
    this.cancels++;
    const order = [...this.orders.values()].find((o) => o.orderId === id);
    if (order && order.orderStatus !== "Filled")
      order.orderStatus = "Cancelled";
    if (this.uncertainCancel) throw Error("CANCEL_ACK_LOST");
    return {};
  }
  fill(client: string, amount?: string) {
    const o = this.orders.get(client),
      remaining = new Decimal(o.qty).minus(o.cumExecQty),
      q = new Decimal(amount ?? remaining),
      price = new Decimal(
        o.price ?? (o.side === "Buy" ? this.price + 0.1 : this.price - 0.1),
      );
    assert.ok(q.lte(remaining));
    const currency =
      this.baseFees && o.side === "Buy"
        ? o.symbol.replace(/USDT$/, "")
        : "USDT";
    const fee = currency === "USDT" ? q.mul(price).mul(0.001) : q.mul(0.001);
    this.fills.push({
      execId: randomUUID(),
      orderLinkId: client,
      execQty: q.toFixed(),
      execPrice: price.toFixed(),
      execFee: fee.toFixed(),
      feeCurrency: currency,
      execTime: String(Date.now()),
    });
    o.cumExecQty = new Decimal(o.cumExecQty).plus(q).toFixed();
    o.orderStatus = new Decimal(o.cumExecQty).eq(o.qty)
      ? "Filled"
      : "PartiallyFilled";
  }
}
const fixtures: Array<{ uid: string; tid: string }> = [];
after(async () => {
  for (const f of fixtures) {
    for (const table of [
      "trade_cycles",
      "order_events",
      "executions",
      "orders",
      "signals",
      "ai_analyses",
      "positions",
      "bots",
      "portfolio_limits",
      "exchange_connections",
      "audit_logs",
    ])
      await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.tid]);
    await admin.query("DELETE FROM workspaces WHERE id=$1", [f.tid]);
    await admin.query("DELETE FROM users WHERE id=$1", [f.uid]);
  }
  await pool.end();
  await admin.end();
});
async function fixture(
  strategy = "dca-v1.0",
  advanced: Record<string, unknown> = {},
) {
  const uid = randomUUID(),
    tid = randomUUID(),
    cid = randomUUID(),
    bid = randomUUID();
  fixtures.push({ uid, tid });
  await admin.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
    [uid, uid + "@example.com", "fixture"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    uid,
  ]);
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Simulator','TESTNET','not-decrypted-by-simulator','CONNECTED','{}')",
      [cid, tid],
    );
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,config,advanced_config,strategy_version,status) VALUES($1,$2,$3,'Execution fixture',$4,$5,$6,'STARTING')",
      [
        bid,
        tid,
        cid,
        JSON.stringify(
          botConfig.parse({
            capital: 100,
            maxTrade: 20,
            stopLossPct: 30,
            takeProfitPct: 50,
            dailyLoss: 30,
            maxDrawdownPct: 50,
            maxTrades: 20,
          }),
        ),
        JSON.stringify(advancedConfig.parse(advanced)),
        strategy,
      ],
    );
    await db.query("INSERT INTO positions(bot_id,tenant_id) VALUES($1,$2)", [
      bid,
      tid,
    ]);
  });
  const broker = new Broker();
  return { uid, tid, cid, bid, broker };
}
function run(
  f: Awaited<ReturnType<typeof fixture>>,
  extra: Partial<NonNullable<Parameters<typeof tick>[2]>> = {},
) {
  return tick(f.tid, f.bid, {
    adapter: f.broker,
    privateReady: true,
    marketReceivedAt: Date.now(),
    executionEnabled: true,
    ...extra,
  });
}
async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  return tenant(f.tid, async (db) => ({
    orders: (
      await db.query(
        "SELECT * FROM orders WHERE bot_id=$1 ORDER BY created_at",
        [f.bid],
      )
    ).rows,
    position: (
      await db.query("SELECT * FROM positions WHERE bot_id=$1", [f.bid])
    ).rows[0],
    bot: (await db.query("SELECT * FROM bots WHERE id=$1", [f.bid])).rows[0],
    portfolio: await portfolioSnapshot(db, f.tid),
  }));
}
async function ageEntry(f: Awaited<ReturnType<typeof fixture>>) {
  await tenant(f.tid, async (db) => {
    await db.query(
      "UPDATE positions SET last_entry_at=now()-interval '2 hours' WHERE bot_id=$1",
      [f.bid],
    );
  });
}
test("real worker submits bounded DCA layers, accounts base fees, and stops at configured entry count", async () => {
  const f = await fixture("dca-v1.0", { dcaStepPct: 2, dcaMaxEntries: 3 });
  f.broker.baseFees = true;
  await run(f);
  await run(f);
  assert.equal(f.broker.creates, 1);
  await ageEntry(f);
  f.broker.price = 97;
  await run(f);
  await run(f);
  await ageEntry(f);
  f.broker.price = 94;
  await run(f);
  await run(f);
  await ageEntry(f);
  f.broker.price = 91;
  await run(f);
  const state = await rows(f);
  assert.equal(f.broker.creates, 3);
  assert.equal(state.position.entry_count, 3);
  assert.ok(Number(state.position.cost) < 60);
  assert.equal(state.portfolio.reserved, 0);
  assert.ok(Number(state.position.fees) > 0);
  assert.equal(state.bot.status, "RUNNING");
});
test("limit orders persist price/TIF, retain reservations through partial fill and uncertain cancellation, then release on reconciliation", async () => {
  const f = await fixture("dca-v1.0", {
    entryType: "LIMIT",
    limitTimeToLiveMinutes: 1,
  });
  f.broker.baseFees = true;
  await run(f);
  let state = await rows(f);
  const order = state.orders[0],
    remote = f.broker.orders.get(order.client_id);
  assert.equal(remote.orderType, "Limit");
  assert.equal(remote.timeInForce, "PostOnly");
  assert.ok(Number(remote.price) < f.broker.price);
  assert.equal(state.portfolio.reserved, 20);
  f.broker.fill(order.client_id, new Decimal(order.quantity).div(2).toFixed());
  await run(f);
  state = await rows(f);
  assert.equal(state.position.entry_count, 1);
  assert.ok(Number(state.position.quantity) > 0);
  assert.equal(state.portfolio.reserved, 20);
  await tenant(f.tid, async (db) => {
    await db.query(
      "UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1",
      [order.id],
    );
  });
  f.broker.uncertainCancel = true;
  await run(f);
  state = await rows(f);
  assert.equal(state.orders[0].state, "CANCELLING");
  assert.equal(state.portfolio.reserved, 20);
  await run(f);
  state = await rows(f);
  assert.equal(state.orders[0].state, "Cancelled");
  assert.equal(state.portfolio.reserved, 0);
  assert.equal(f.broker.creates, 1);
});
test("grid rung fills survive restart, cannot repeat in a cycle, and reset after aggregate exit", async () => {
  const f = await fixture("grid-accumulation-v1.1", {
    gridLower: 80,
    gridUpper: 120,
    gridLevels: 5,
  });
  f.broker.price = 90;
  await run(f);
  await run(f);
  assert.equal(f.broker.creates, 1);
  assert.deepEqual((await rows(f)).position.grid_levels_filled, [1]);
  f.broker.price = 80;
  await run(f);
  await run(f);
  assert.equal(f.broker.creates, 2);
  assert.deepEqual((await rows(f)).position.grid_levels_filled.sort(), [0, 1]);
  f.broker.price = 105;
  await run(f);
  await run(f);
  let state = await rows(f);
  assert.equal(Number(state.position.quantity), 0);
  assert.deepEqual(state.position.grid_levels_filled, []);
  assert.equal(state.position.strategy_cycle, 1);
  f.broker.price = 90;
  await run(f);
  state = await rows(f);
  assert.equal(f.broker.creates, 4);
  assert.equal(state.orders.at(-1).strategy_cycle, 1);
});
test("concurrent workers recover one durable intent without creating duplicate orders", async () => {
  const f = await fixture();
  await Promise.all([
    run(f, {
      afterSubmitting: async () => {
        // This competing worker runs after the transaction lock was released by COMMIT.
        await run(f);
        assert.equal(f.broker.creates, 0);
      },
    }),
    run(f),
  ]);
  assert.equal(f.broker.creates, 1);
  assert.equal((await rows(f)).orders.length, 1);
});
test("crash after durable intent is recoverable; crash after attempted-send marker never blindly resends", async () => {
  const prepared = await fixture();
  await assert.rejects(
    run(prepared, {
      afterIntent: async () => {
        throw Error("SIMULATED_CRASH");
      },
    }),
    /SIMULATED_CRASH/,
  );
  assert.equal((await rows(prepared)).orders[0].state, "INTERNAL_CREATED");
  assert.equal(prepared.broker.creates, 0);
  await run(prepared);
  assert.equal(prepared.broker.creates, 1);
  const attempted = await fixture();
  await assert.rejects(
    run(attempted, {
      afterSubmitting: async () => {
        throw Error("SIMULATED_SEND_CRASH");
      },
    }),
    /SIMULATED_SEND_CRASH/,
  );
  assert.equal((await rows(attempted)).orders[0].state, "SUBMITTING");
  await run(attempted);
  const state = await rows(attempted);
  assert.equal(attempted.broker.creates, 0);
  assert.equal(state.orders[0].state, "UNKNOWN");
  assert.equal(state.bot.status, "RISK_LOCKED");
  assert.equal(state.portfolio.reserved, 20);
});
test("lost acknowledgement reconciles the existing exchange order and fill without retry", async () => {
  const f = await fixture();
  f.broker.loseAck = true;
  await run(f);
  assert.equal((await rows(f)).orders[0].state, "UNKNOWN");
  await run(f);
  const state = await rows(f);
  assert.equal(f.broker.creates, 1);
  assert.equal(state.orders[0].state, "Filled");
  assert.equal(state.portfolio.reserved, 0);
  assert.ok(Number(state.position.quantity) > 0);
  assert.equal(state.bot.status, "RISK_LOCKED");
});
test("stopping cancels resting entries without creating a replacement", async () => {
  const f = await fixture("dca-v1.0", { entryType: "LIMIT" });
  await run(f);
  await tenant(f.tid, async (db) => {
    await db.query("UPDATE bots SET status='STOPPED' WHERE id=$1", [f.bid]);
  });
  await run(f);
  assert.equal((await rows(f)).portfolio.reserved, 20);
  await run(f);
  const state = await rows(f);
  assert.equal(state.orders[0].state, "Cancelled");
  assert.equal(state.portfolio.reserved, 0);
  assert.equal(f.broker.creates, 1);
  assert.equal(f.broker.cancels, 1);
});
test("global stop between intent preparation and network submission prevents sending", async () => {
  const f = await fixture();
  try {
    await run(f, {
      afterSubmitting: async () => {
        await admin.query(
          "UPDATE platform_controls SET execution_stopped=true",
        );
      },
    });
    assert.equal(f.broker.creates, 0);
    assert.equal((await rows(f)).orders[0].state, "Cancelled");
  } finally {
    await admin.query("UPDATE platform_controls SET execution_stopped=false");
  }
});
test("stale or disconnected market/private state cannot submit an advanced strategy order", async () => {
  for (const extra of [
    { privateReady: false },
    { marketReceivedAt: Date.now() - 60000 },
  ]) {
    const f = await fixture();
    await run(f, extra);
    assert.equal(f.broker.creates, 0);
  }
});
test("reconciliation follows pagination and holds terminal orders until all exchange fills are present", async () => {
  const f = await fixture("dca-v1.0", { entryType: "LIMIT" });
  await run(f);
  const order = (await rows(f)).orders[0];
  f.broker.fill(order.client_id, new Decimal(order.quantity).div(2).toFixed());
  f.broker.fill(order.client_id);
  const fills = [...f.broker.fills];
  f.broker.getExecutions = async () => ({ list: [fills[0]] });
  assert.equal(
    await tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker)),
    false,
  );
  assert.equal((await rows(f)).orders[0].state, "RECONCILING");
  assert.equal((await rows(f)).portfolio.reserved, 20);
  f.broker.getExecutions = async (cursor?: string) =>
    cursor
      ? { list: [fills[1]] }
      : { list: [fills[0]], nextPageCursor: "second" };
  await tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker));
  assert.equal((await rows(f)).orders[0].state, "Filled");
  assert.equal((await rows(f)).position.entry_count, 1);
});
test("OKX Demo worker reconciles an acknowledgement loss using exchange-only fill IDs without resending", async () => {
  const { OKXAdapter } = await import("../packages/exchanges/src/index.ts");
  const f = await fixture();
  await admin.query(
    "UPDATE exchange_connections SET provider='OKX' WHERE id=$1",
    [f.cid],
  );
  const reply = (data: any[]) =>
    new Response(JSON.stringify({ code: "0", data }));
  const transport = (async (url: any, init: any) => {
    const u = new URL(url),
      path = u.pathname;
    if (path.endsWith("/instruments"))
      return reply([
        {
          state: "live",
          tickSz: "0.01",
          lotSz: "0.000001",
          minSz: "0.000001",
          maxMktSz: "100000",
          maxLmtSz: "100000",
        },
      ]);
    if (path.endsWith("/ticker"))
      return reply([
        {
          last: String(f.broker.price),
          bidPx: String(f.broker.price - 0.1),
          askPx: String(f.broker.price + 0.1),
        },
      ]);
    if (path.endsWith("/candles"))
      return reply(
        (await f.broker.getCandles("BTCUSDT"))
          .reverse()
          .map((c) =>
            [c.time, c.open, c.high, c.low, c.close, c.volume, 0, 0, "1"].map(
              String,
            ),
          ),
      );
    if (path.endsWith("/balance"))
      return reply([
        {
          details: (await f.broker.getBalances()).list[0].coin.map(
            (c: any) => ({
              ccy: c.coin,
              cashBal: c.walletBalance,
              availBal: c.walletBalance,
            }),
          ),
        },
      ]);
    if (path.endsWith("/orders-pending")) return reply([]);
    if (path.endsWith("/fills-history"))
      return reply(
        f.broker.fills.map((e: any) => ({
          billId: e.execId,
          ordId: f.broker.orders.get(e.orderLinkId).orderId,
          fillSz: e.execQty,
          fillPx: e.execPrice,
          ts: e.execTime,
          fee: String(-Number(e.execFee)),
          feeCcy: e.feeCurrency,
        })),
      );
    if (path.endsWith("/order") && init.method === "GET") {
      const o = f.broker.orders.get(u.searchParams.get("clOrdId")!);
      return reply(
        o
          ? [
              {
                ordId: o.orderId,
                clOrdId: o.orderLinkId,
                instId: "BTC-USDT",
                state: "filled",
                accFillSz: o.cumExecQty,
              },
            ]
          : [],
      );
    }
    if (path.endsWith("/order") && init.method === "POST") {
      const p = JSON.parse(init.body);
      await f.broker.placeOrder({
        symbol: p.instId.replace("-", ""),
        side: p.side === "buy" ? "Buy" : "Sell",
        qty: p.sz,
        orderLinkId: p.clOrdId,
        orderType: "Market",
      });
      throw Error("SIMULATED_RESPONSE_LOSS");
    }
    throw Error("UNEXPECTED_ENDPOINT " + path);
  }) as typeof fetch;
  const adapter = new OKXAdapter(
    "TESTNET",
    { apiKey: "fixture", apiSecret: "fixture", passphrase: "fixture" },
    transport,
  );
  await run(f, { adapter });
  assert.equal(f.broker.creates, 1);
  assert.match((await rows(f)).orders[0].client_id, /^[a-z0-9]{32}$/);
  await run(f, { adapter });
  const state = await rows(f);
  assert.equal(f.broker.creates, 1);
  assert.equal(state.orders[0].state, "Filled");
  assert.ok(Number(state.position.quantity) > 0);
  assert.equal(state.position.entry_count, 1);
});
test("malformed reconciliation pages and unknown external fills cannot authorize execution", async () => {
  const f = await fixture();
  f.broker.getOpenOrders = async () => ({}) as any;
  await assert.rejects(run(f), /INVALID_RECONCILIATION_PAGE/);
  assert.equal(f.broker.creates, 0);
  f.broker.getOpenOrders = async () => ({ list: [] });
  f.broker.getExecutions = async () => ({
    list: [{ execId: "untracked", orderLinkId: "someone-else" }],
  });
  await assert.rejects(run(f), /UNEXPECTED_EXCHANGE_EXECUTION/);
  assert.equal(f.broker.creates, 0);
});
test("unknown order states retain allocation and lock new entries", async () => {
  const f = await fixture("dca-v1.0", { entryType: "LIMIT" });
  await run(f);
  const o = (await rows(f)).orders[0];
  f.broker.orders.get(o.client_id).orderStatus = "UNDOCUMENTED_STATE";
  await run(f);
  const state = await rows(f);
  assert.equal(state.orders[0].state, "UNKNOWN");
  assert.equal(state.portfolio.reserved, 20);
  assert.equal(f.broker.creates, 1);
});
test("partial-fill cancellation releases only the pending reservation after matching executions", async () => {
  const f = await fixture("dca-v1.0", { entryType: "LIMIT" });
  await run(f);
  const o = (await rows(f)).orders[0];
  f.broker.fill(o.client_id, new Decimal(o.quantity).div(2).toFixed());
  f.broker.orders.get(o.client_id).orderStatus = "PartiallyFilledCanceled";
  assert.equal(
    await tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker)),
    true,
  );
  const state = await rows(f);
  assert.equal(state.orders[0].state, "PartiallyFilledCanceled");
  assert.equal(state.portfolio.reserved, 0);
  assert.ok(Number(state.position.quantity) > 0);
});
test("a changed duplicate execution ID rolls back instead of silently changing financial history", async () => {
  const f = await fixture();
  await run(f);
  await run(f);
  const before = await rows(f),
    fill = f.broker.fills[0];
  fill.execPrice = String(Number(fill.execPrice) + 1);
  await assert.rejects(
    tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker)),
    /EXECUTION_ID_CONFLICT/,
  );
  const after = await rows(f);
  assert.equal(after.position.quantity, before.position.quantity);
  assert.equal(after.position.cost, before.position.cost);
});
test("missing fee currency, contradictory order identity and impossible fill totals fail closed", async () => {
  for (const scenario of ["currency", "identity", "quantity"]) {
    const f = await fixture();
    await run(f);
    const original = f.broker.getOrder.bind(f.broker);
    if (scenario === "currency") delete f.broker.fills[0].feeCurrency;
    else
      f.broker.getOrder = async (id: string) => {
        const r = await original(id);
        return {
          list: r.list.map((o: any) => ({
            ...o,
            ...(scenario === "identity"
              ? { orderLinkId: "different-client" }
              : { cumExecQty: "999999" }),
          })),
        };
      };
    await assert.rejects(
      tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker)),
      scenario === "currency"
        ? /FEE_CURRENCY_REQUIRED/
        : scenario === "identity"
          ? /EXCHANGE_ORDER_IDENTITY_MISMATCH/
          : /INVALID_TERMINAL_QUANTITY/,
    );
    assert.equal(Number((await rows(f)).position.quantity), 0);
  }
});
test("losing private-feed readiness after the committed submission marker prevents the network send", async () => {
  const f = await fixture();
  const runtime = {
    adapter: f.broker,
    privateReady: true,
    marketReceivedAt: Date.now(),
    executionEnabled: true,
    afterSubmitting: async () => {
      runtime.privateReady = false;
    },
  };
  await tick(f.tid, f.bid, runtime);
  assert.equal(f.broker.creates, 0);
  assert.equal((await rows(f)).orders[0].state, "Cancelled");
});
test("two tenants reconcile identical exchange execution IDs independently and stopping one does not stop the other", async () => {
  const a = await fixture(),
    b = await fixture();
  await Promise.all([run(a), run(b)]);
  b.broker.fills[0].execId = a.broker.fills[0].execId;
  await Promise.all([run(a), run(b)]);
  assert.ok(Number((await rows(a)).position.quantity) > 0);
  assert.ok(Number((await rows(b)).position.quantity) > 0);
  await admin.query("UPDATE bots SET status='STOPPED' WHERE id=$1", [a.bid]);
  await admin.query(
    "UPDATE positions SET last_entry_at=now()-interval '2 hours' WHERE bot_id=$1",
    [b.bid],
  );
  a.broker.price = 97;
  b.broker.price = 97;
  await Promise.all([run(a), run(b)]);
  assert.equal(a.broker.creates, 1);
  assert.equal(b.broker.creates, 2);
  await run(b);
  assert.equal((await rows(b)).position.entry_count, 2);
});
test("a fill cannot reuse a known client identifier with a different exchange order identity", async () => {
  const f = await fixture();
  await run(f);
  f.broker.fills[0].orderId = "contradictory-exchange-order";
  await assert.rejects(
    tenant(f.tid, (db) => reconcile(db, f.tid, f.cid, f.broker)),
    /EXECUTION_ORDER_IDENTITY_MISMATCH/,
  );
  assert.equal(Number((await rows(f)).position.quantity), 0);
});

test("disabling Testnet execution after the durable marker blocks the final order send", async () => {
  const f = await fixture();
  let enabled = true;
  await run(f, {
    isExecutionEnabled: async () => enabled,
    afterSubmitting: async () => {
      enabled = false;
    },
  });
  assert.equal(f.broker.creates, 0);
  assert.equal((await rows(f)).orders[0].state, "Cancelled");
});
