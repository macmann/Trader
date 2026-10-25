import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import pg from "pg";
import { pool, tenant } from "../apps/api/src/db.ts";
import { tick } from "../apps/worker/src/engine.ts";
import {
  PerpetualExchange,
  type PerpetualAdapter,
  type ContractPosition,
} from "../packages/exchanges/src/perpetuals.ts";
import { botConfig } from "../packages/core/src/index.ts";
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
const fixtures: { uid: string; tid: string }[] = [];
after(async () => {
  for (const f of fixtures) {
    for (const table of [
      "futures_funding",
      "ai_strategy_decisions",
      "trade_cycles",
      "order_events",
      "executions",
      "orders",
      "signals",
      "positions",
      "bots",
      "exchange_connections",
      "audit_logs",
      "usage_records",
    ])
      await admin.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.tid]);
    await admin.query("DELETE FROM workspaces WHERE id=$1", [f.tid]);
    await admin.query("DELETE FROM users WHERE id=$1", [f.uid]);
  }
  await pool.end();
  await admin.end();
});
class Broker implements PerpetualAdapter {
  price = 100;
  closeOnly = false;
  creates = 0;
  lostAck = false;
  external: ContractPosition[] | null = null;
  cash = "1000";
  fundingEvents: { id: string; amount: string; time: number }[] = [];
  orders = new Map<string, any>();
  fills: any[] = [];
  async validateCredentials() {
    return {
      readAccount: true,
      trading: true,
      withdrawals: false,
      ipBinding: [],
    };
  }
  async getBalances() {
    return { list: [{ coin: [{ coin: "USDT", walletBalance: this.cash }] }] };
  }
  async availableMargin() {
    return this.cash;
  }
  async getInstrument(_s: string) {
    return {
      list: [
        {
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: {
            basePrecision: "0.000001",
            minOrderQty: "0.000001",
            minOrderAmt: "1",
            maxMarketOrderQty: "1000",
            maxLimitOrderQty: "1000",
          },
        },
      ],
    };
  }
  async getTicker(_s: string) {
    return {
      list: [
        {
          lastPrice: String(this.price),
          bid1Price: String(this.price - 0.05),
          ask1Price: String(this.price + 0.05),
          observedAt: Date.now(),
        },
      ],
    };
  }
  async getCandles(_s: string, interval = "15", limit = 200) {
    const ms = +interval * 60000,
      last = Math.floor(Date.now() / ms) * ms - ms;
    return Array.from({ length: limit }, (_, i) => ({
      time: last - (limit - 1 - i) * ms,
      open: this.price,
      high: this.price + 1,
      low: this.price - 1,
      close: this.price,
      volume: 100,
    }));
  }
  async getOpenOrders() {
    return { list: [] };
  }
  async getOrder(id: string) {
    return { list: this.orders.has(id) ? [this.orders.get(id)] : [] };
  }
  async getExecutions() {
    return { list: this.fills };
  }
  async cancelOrder() {
    return {};
  }
  async prepare() {}
  async funding() {
    return this.fundingEvents;
  }
  async placeOrder(p: any) {
    this.creates++;
    if (this.orders.has(p.orderLinkId)) throw Error("DUPLICATE");
    const o = {
      ...p,
      orderId: randomUUID(),
      orderStatus: "Filled",
      cumExecQty: p.qty,
      reduceOnly: this.closeOnly,
    };
    this.orders.set(p.orderLinkId, o);
    this.fills.push({
      execId: randomUUID(),
      orderLinkId: p.orderLinkId,
      orderId: o.orderId,
      symbol: p.symbol,
      side: p.side,
      execQty: p.qty,
      execPrice: String(this.price),
      execFee: "0.01",
      feeCurrency: "USDT",
      execTime: String(Date.now()),
      execType: "Trade",
    });
    if (this.lostAck) {
      this.lostAck = false;
      throw Error("ACK_LOST");
    }
    return { orderId: o.orderId };
  }
  async contractPositions(): Promise<ContractPosition[]> {
    if (this.external) return this.external;
    let qty = new Decimal(0),
      cost = new Decimal(0);
    for (const f of this.fills) {
      const signed = new Decimal(f.execQty).mul(f.side === "Buy" ? 1 : -1);
      if (qty.isZero() || qty.isPositive() === signed.isPositive())
        cost = cost.plus(signed.abs().mul(f.execPrice));
      else
        cost = cost
          .mul(Decimal.max(0, qty.abs().minus(signed.abs())))
          .div(qty.abs());
      qty = qty.plus(signed);
    }
    return qty.isZero()
      ? []
      : [
          {
            quantity: qty.abs().toFixed(),
            entryPrice: cost.div(qty.abs()).toFixed(),
            direction: qty.gt(0) ? "LONG" : "SHORT",
            liquidationPrice: qty.gt(0) ? "0" : "200",
            leverage: "1",
            isolated: true,
          },
        ];
  }
}
async function fixture() {
  const uid = randomUUID(),
    tid = randomUUID(),
    cid = randomUUID(),
    bid = randomUUID();
  fixtures.push({ uid, tid });
  await admin.query(
    "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",
    [uid, uid + "@example.com"],
  );
  await admin.query("INSERT INTO workspaces(id,owner_id) VALUES($1,$2)", [
    tid,
    uid,
  ]);
  await tenant(tid, async (db) => {
    await db.query(
      "INSERT INTO exchange_connections(id,tenant_id,name,environment,credentials,status,permissions) VALUES($1,$2,'Future fixture','TESTNET','fixture','CONNECTED','{}')",
      [cid, tid],
    );
    await db.query(
      "INSERT INTO bots(id,tenant_id,connection_id,name,strategy_version,market_type,config,ai_strategy_config,status) VALUES($1,$2,$3,'Future AI','ai-v1.0','LINEAR',$4,$5,'STARTING')",
      [
        bid,
        tid,
        cid,
        JSON.stringify(botConfig.parse({ capital: 100, maxTrade: 20 })),
        JSON.stringify({ model: "fixture", minConfidence: 70 }),
      ],
    );
    await db.query("INSERT INTO positions(bot_id,tenant_id) VALUES($1,$2)", [
      bid,
      tid,
    ]);
  });
  return { uid, tid, cid, bid, broker: new Broker(), action: "BUY", calls: 0 };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, extra: any = {}) {
  return tick(f.tid, f.bid, {
    adapter: f.broker,
    privateReady: true,
    marketReceivedAt: Date.now(),
    executionEnabled: true,
    aiProvider: {
      id: "fake",
      model: "fixture",
      analyzeTrade: async (input: any) => {
        f.calls++;
        assert.equal(input.marketType, "LINEAR");
        return {
          value: {
            action: f.action,
            confidence: 90,
            reasons: ["Fixture decision"],
          },
          inputTokens: 1,
          outputTokens: 1,
        };
      },
    },
    ...extra,
  } as any);
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return tenant(f.tid, async (db) => ({
    position: (
      await db.query("SELECT * FROM positions WHERE bot_id=$1", [f.bid])
    ).rows[0],
    orders: (
      await db.query(
        "SELECT * FROM orders WHERE bot_id=$1 ORDER BY created_at,id",
        [f.bid],
      )
    ).rows,
    cycles: (
      await db.query("SELECT * FROM trade_cycles WHERE bot_id=$1", [f.bid])
    ).rows,
  }));
}
test("short entry, restart reconciliation and reduce-only buy exit produce correct P&L", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture();
  f.action = "SELL_SHORT";
  await run(f);
  await run(f);
  assert.equal(f.broker.creates, 1);
  let s = await state(f);
  assert.equal(s.position.position_direction, "SHORT");
  assert.ok(Number(s.position.quantity) > 0);
  assert.equal([...f.broker.orders.values()][0].side, "Sell");
  assert.equal([...f.broker.orders.values()][0].reduceOnly, false);
  assert.equal(f.calls, 1);
  clock += 900000;
  f.action = "EXIT";
  f.broker.price = 99;
  await run(f);
  await run(f);
  s = await state(f);
  assert.equal(f.broker.creates, 2);
  assert.equal(Number(s.position.quantity), 0);
  assert.equal(s.cycles.length, 1);
  assert.ok(Number(s.position.realized_pnl) > 0);
  const close = [...f.broker.orders.values()][1];
  assert.equal(close.side, "Buy");
  assert.equal(close.reduceOnly, true);
});
test("long protection closes without AI and reconciles funding once", async () => {
  const f = await fixture();
  await run(f);
  await run(f);
  const s = await state(f);
  assert.ok(Number(s.position.quantity) > 0);
  f.broker.fundingEvents = [
    { id: "funding-1", amount: "-0.05", time: Date.now() },
  ];
  f.action = "HOLD";
  f.broker.price = 97;
  const candles = f.broker.getCandles.bind(f.broker);
  f.broker.getCandles = async () => {
    throw Error("CANDLES_UNAVAILABLE");
  };
  await run(f);
  f.broker.getCandles = candles;
  await run(f);
  const closed = await state(f);
  assert.equal(Number(closed.position.quantity), 0);
  assert.equal(Number(closed.position.funding_total), -0.05);
  assert.equal(f.calls, 1);
  assert.equal(f.broker.creates, 2);
  assert.equal([...f.broker.orders.values()][1].reduceOnly, true);
});
test("ambiguous futures acknowledgement never resends and positions reconcile independently per tenant", async () => {
  const a = await fixture(),
    b = await fixture();
  a.broker.lostAck = true;
  await run(a);
  await run(b);
  await run(a);
  await run(a);
  assert.equal(a.broker.creates, 1);
  assert.equal(b.broker.creates, 1);
  assert.ok(Number((await state(a)).position.quantity) > 0);
  assert.equal(
    await tenant(
      b.tid,
      async (db) =>
        (await db.query("SELECT * FROM orders WHERE bot_id=$1", [a.bid]))
          .rowCount,
    ),
    0,
  );
});
test("unowned positions, insufficient margin and unsafe private readiness cannot enter futures", async () => {
  const f = await fixture();
  f.broker.external = [
    {
      quantity: "1",
      direction: "LONG",
      entryPrice: "100",
      liquidationPrice: "0",
      leverage: "1",
      isolated: true,
    },
  ];
  await assert.rejects(run(f), /UNEXPECTED_FUTURES_POSITION/);
  assert.equal(f.broker.creates, 0);
  f.broker.external = null;
  f.broker.cash = "1";
  await run(f);
  assert.equal(f.broker.creates, 0);
  const other = await fixture();
  await run(other, { privateReady: false });
  assert.equal(other.broker.creates, 0);
});
test("OKX perpetual adapter converts contracts to base units and sends isolated reduce-only exits", async () => {
  const requests: any[] = [];
  const transport: any = async (url: string, init: any) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const data = path.endsWith("/instruments")
      ? [
          {
            ctType: "linear",
            settleCcy: "USDT",
            ctValCcy: "BTC",
            state: "live",
            ctVal: "0.01",
            ctMult: "1",
            lotSz: "1",
            minSz: "1",
            tickSz: "0.1",
            maxMktSz: "1000",
            maxLmtSz: "1000",
          },
        ]
      : path.endsWith("/ticker")
        ? [{ bidPx: "99.9", askPx: "100.1" }]
        : path.endsWith("/mark-price")
          ? [{ markPx: "100", ts: String(Date.now()) }]
          : path.endsWith("/config")
            ? [{ posMode: "net_mode" }]
            : path.endsWith("/positions")
              ? []
              : [{ sCode: "0", ordId: "remote" }];
    return new Response(JSON.stringify({ code: "0", data }));
  };
  const adapter = new PerpetualExchange(
    "OKX",
    "BTCUSDT",
    { apiKey: "fixture", apiSecret: "fixture", passphrase: "fixture" },
    transport,
  );
  const instrument = (await adapter.getInstrument("BTCUSDT")).list[0];
  assert.equal(instrument.lotSizeFilter.basePrecision, "0.01");
  await adapter.contractPositions();
  await adapter.prepare("SHORT");
  adapter.closeOnly = true;
  await adapter.placeOrder({
    symbol: "BTCUSDT",
    side: "Buy",
    qty: "0.02",
    orderLinkId: "fixture",
  });
  const body = requests.at(-1).body;
  assert.equal(body.instId, "BTC-USDT-SWAP");
  assert.equal(body.sz, "2");
  assert.equal(body.tdMode, "isolated");
  assert.equal(body.reduceOnly, true);
  assert.equal(body.posSide, "net");
  assert.equal(body.ordType, "ioc");
  assert.ok(Number(body.px) <= 100.1 * 1.003);
});

test("Bybit perpetual endpoints require isolated one-way margin and close with reduceOnly", async () => {
  const calls: any[] = [];
  const adapter = new PerpetualExchange("BYBIT", "BTCUSDT");
  adapter.bybit.request = async (
    path: string,
    params: any = {},
    method: any = "GET",
  ) => {
    calls.push({ path, params, method });
    if (path === "/v5/account/info") return { marginMode: "ISOLATED_MARGIN" };
    if (path === "/v5/position/list")
      return {
        list: [
          {
            size: "0.01",
            side: "Sell",
            avgPrice: "100",
            liqPrice: "200",
            leverage: "1",
            positionIdx: 0,
          },
        ],
      };
    if (path === "/v5/account/transaction-log")
      return {
        list: [
          {
            id: "funding",
            symbol: "BTCUSDT",
            funding: "-0.1",
            transactionTime: String(Date.now()),
          },
        ],
      };
    return { orderId: "future-order" };
  };
  const positions = await adapter.contractPositions();
  assert.equal(positions[0].direction, "SHORT");
  await adapter.prepare("SHORT");
  adapter.closeOnly = true;
  await adapter.placeOrder({
    symbol: "BTCUSDT",
    side: "Buy",
    qty: "0.01",
    orderLinkId: "fixture",
  });
  const order = calls.find((c) => c.path === "/v5/order/create");
  assert.equal(order.params.category, "linear");
  assert.equal(order.params.reduceOnly, true);
  assert.equal(order.params.positionIdx, 0);
  assert.equal("marketUnit" in order.params, false);
  assert.equal((await adapter.funding(Date.now() - 1000))[0].amount, "-0.1");
  adapter.bybit.request = async () => ({ marginMode: "REGULAR_MARGIN" });
  await assert.rejects(adapter.contractPositions(), /ISOLATED_MARGIN_REQUIRED/);
});

test("partial short fills apply once and never create another entry while unresolved", async () => {
  const f = await fixture();
  f.action = "SELL_SHORT";
  await run(f);
  const order = [...f.broker.orders.values()][0],
    full = new Decimal(order.qty),
    half = full.div(2).toFixed();
  f.broker.fills[0].execQty = half;
  order.cumExecQty = half;
  order.orderStatus = "PartiallyFilled";
  await run(f);
  await run(f);
  let s = await state(f);
  assert.equal(new Decimal(s.position.quantity).toFixed(), half);
  assert.equal(s.position.position_direction, "SHORT");
  assert.equal(f.broker.creates, 1);
  f.broker.fills.push({
    ...f.broker.fills[0],
    execId: randomUUID(),
    execQty: full.minus(half).toFixed(),
    execTime: String(Date.now()),
  });
  order.cumExecQty = full.toFixed();
  order.orderStatus = "Filled";
  await run(f);
  await run(f);
  s = await state(f);
  assert.equal(new Decimal(s.position.quantity).toFixed(), full.toFixed());
  assert.equal(Number(s.position.fees), 0.02);
  assert.equal(f.broker.creates, 1);
});
test("disabling execution after the futures send marker prevents the network order", async () => {
  const f = await fixture();
  let enabled = true;
  await run(f, {
    isExecutionEnabled: async () => enabled,
    afterSubmitting: async () => {
      enabled = false;
    },
  });
  assert.equal(f.broker.creates, 0);
  assert.equal((await state(f)).orders[0].state, "Cancelled");
});
