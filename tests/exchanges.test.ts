import { BybitAdapter } from "../packages/core/src/index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  OKXAdapter,
  exchangeAdapter,
} from "../packages/exchanges/src/index.ts";
import { instrumentVeto } from "../packages/trading/src/index.ts";
const credentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  passphrase: "test-passphrase",
};
const response = (data: any[]) =>
  new Response(JSON.stringify({ code: "0", data }));
test("OKX Demo signs the exact request path/body and never enables live or withdrawals", async () => {
  const requests: any[] = [];
  const transport = (async (url: any, init: any) => {
    requests.push({ url, init });
    return response(
      url.includes("/account/config")
        ? [{ perm: "read_only,trade" }]
        : [{ details: [] }],
    );
  }) as typeof fetch;
  const adapter = new OKXAdapter("TESTNET", credentials, transport);
  assert.equal((await adapter.validateCredentials()).withdrawals, false);
  const { url, init } = requests[0],
    headers = init.headers;
  assert.equal(headers["x-simulated-trading"], "1");
  assert.equal(headers["OK-ACCESS-PASSPHRASE"], credentials.passphrase);
  assert.equal(
    headers["OK-ACCESS-SIGN"],
    createHmac("sha256", credentials.apiSecret)
      .update(headers["OK-ACCESS-TIMESTAMP"] + "GET" + new URL(url).pathname)
      .digest("base64"),
  );
  assert.throws(
    () => exchangeAdapter("OKX", "LIVE", credentials),
    /LIVE_DISABLED/,
  );
  const dangerous = new OKXAdapter("TESTNET", credentials, (async () =>
    response([{ perm: "read_only,trade,withdraw" }])) as typeof fetch);
  await assert.rejects(dangerous.validateCredentials(), /PERMISSION_ERROR/);
  assert.throws(
    () => exchangeAdapter("UNKNOWN", "TESTNET"),
    /UNSUPPORTED_EXCHANGE/,
  );
});
test("OKX Spot payloads preserve base quantity, limit policy and cancel identity", async () => {
  const calls: any[] = [];
  const adapter = new OKXAdapter("TESTNET", credentials, (async (
    url: any,
    init: any,
  ) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response([{ sCode: "0", ordId: "exchange-1" }]);
  }) as typeof fetch);
  await adapter.placeOrder({
    symbol: "BTCUSDT",
    side: "Buy",
    qty: "0.001",
    orderLinkId: "abc123",
    orderType: "Market",
  });
  assert.deepEqual(calls[0].body, {
    instId: "BTC-USDT",
    tdMode: "cash",
    clOrdId: "abc123",
    side: "buy",
    ordType: "market",
    sz: "0.001",
    tgtCcy: "base_ccy",
  });
  await adapter.placeOrder({
    symbol: "ETHUSDT",
    side: "Buy",
    qty: "0.01",
    orderLinkId: "abc124",
    orderType: "Limit",
    price: "2000",
    timeInForce: "PostOnly",
  });
  assert.equal(calls[1].body.ordType, "post_only");
  assert.equal(calls[1].body.px, "2000");
  assert.ok(!("tgtCcy" in calls[1].body));
  await adapter.cancelOrder("ETHUSDT", "exchange-1");
  assert.deepEqual(calls[2].body, { instId: "ETH-USDT", ordId: "exchange-1" });
  await assert.rejects(
    adapter.placeOrder({
      symbol: "BTCUSDT",
      side: "Buy",
      qty: "1",
      orderLinkId: "uuid-with-dashes",
    }),
    /INVALID_CLIENT_ID/,
  );
  const c = calls[1];
  assert.equal(
    c.init.headers["OK-ACCESS-SIGN"],
    createHmac("sha256", credentials.apiSecret)
      .update(
        c.init.headers["OK-ACCESS-TIMESTAMP"] +
          "POST" +
          new URL(c.url).pathname +
          c.init.body,
      )
      .digest("base64"),
  );
});
test("OKX metadata, partial-order states, base fees and exchange-only execution identity normalize for shared risk/reconciliation", async () => {
  const adapter = new OKXAdapter("TESTNET", credentials, (async (url: any) => {
    const path = new URL(url).pathname;
    if (path.endsWith("instruments"))
      return response([
        {
          state: "live",
          tickSz: "0.01",
          lotSz: "0.000001",
          minSz: "0.00001",
          maxMktSz: "100",
          maxLmtSz: "1000",
        },
      ]);
    if (path.endsWith("orders-pending"))
      return response([
        {
          ordId: "1",
          clOrdId: "abc",
          instId: "BTC-USDT",
          state: "partially_filled",
          accFillSz: "0.01",
        },
      ]);
    return response([
      {
        billId: "fill-1",
        ordId: "1",
        fillSz: "0.01",
        fillPx: "100",
        ts: "1000",
        fee: "-0.00001",
        feeCcy: "BTC",
      },
    ]);
  }) as typeof fetch);
  const metadata = (await adapter.getInstrument("BTCUSDT")).list[0];
  assert.deepEqual(instrumentVeto("0.001", 100, metadata.lotSizeFilter), []);
  assert.equal(
    (await adapter.getOpenOrders()).list[0].orderStatus,
    "PartiallyFilled",
  );
  const fill = (await adapter.getExecutions()).list[0];
  assert.equal(fill.orderId, "1");
  assert.equal(fill.orderLinkId, "");
  assert.equal(fill.execFee, "0.00001");
  assert.equal(fill.feeCurrency, "BTC");
});

test("OKX candle requests map each selectable interval and exclude incomplete candles", async () => {
  const bars: string[] = [];
  const adapter = new OKXAdapter("TESTNET", undefined, async (url: any) => {
    bars.push(new URL(String(url)).searchParams.get("bar")!);
    return response([
      ["1000", "10", "12", "9", "11", "100", "0", "0", "0"],
      ["0", "10", "12", "9", "11", "100", "0", "0", "1"],
    ]);
  });
  for (const interval of ["5", "15", "30", "60", "240", "1440"]) {
    const candles = await adapter.getCandles("BTCUSDT", interval, 200);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].time, 0);
  }
  assert.deepEqual(bars, ["5m", "15m", "30m", "1H", "4H", "1Dutc"]);
  await assert.rejects(
    adapter.getCandles("BTCUSDT", "2"),
    /UNSUPPORTED_TIMEFRAME/,
  );
});

test("Bybit Spot translates daily intervals without changing minute intervals", async () => {
  const adapter = new BybitAdapter("TESTNET"),
    intervals: string[] = [];
  adapter.request = async (_path: string, p: any) => {
    intervals.push(p.interval);
    assert.equal(p.category, "spot");
    return { list: [] };
  };
  for (const interval of ["5", "15", "30", "60", "240", "1440"])
    await adapter.getCandles("BTCUSDT", interval);
  assert.deepEqual(intervals, ["5", "15", "30", "60", "240", "D"]);
});

test("OKX market limits support a notional ceiling without accepting missing/invalid limits", async () => {
  const adapter = new OKXAdapter("TESTNET", undefined, async () =>
    response([
      {
        state: "live",
        tickSz: "0.01",
        lotSz: "0.000001",
        minSz: "0.00001",
        maxMktSz: "",
        maxMktAmt: "1000000",
        maxLmtSz: "1000",
      },
    ]),
  );
  const filter = (await adapter.getInstrument("ETHUSDT")).list[0].lotSizeFilter;
  assert.deepEqual(instrumentVeto("0.008", 2332, filter), []);
  assert.ok(
    instrumentVeto("500", 2332, filter).includes(
      "ABOVE_EXCHANGE_MAXIMUM_NOTIONAL",
    ),
  );
  assert.deepEqual(instrumentVeto("0.000001", 2332, filter), [
    "BELOW_EXCHANGE_MINIMUM_QUANTITY",
  ]);
  assert.deepEqual(
    instrumentVeto("0.008", 2332, { ...filter, maxOrderAmt: "" }),
    ["INVALID_INSTRUMENT_METADATA"],
  );
});
test("OKX preserves per-order rejection code under a batch failure without exposing raw messages", async () => {
  const adapter = new OKXAdapter(
    "TESTNET",
    { ...credentials, apiKey: "rejection-fixture" },
    async () =>
      new Response(
        JSON.stringify({
          code: "1",
          msg: "sensitive raw message",
          data: [{ sCode: "51008", sMsg: "raw balance" }],
        }),
      ),
  );
  await assert.rejects(
    adapter.placeOrder({
      symbol: "ETHUSDT",
      side: "Buy",
      qty: "0.01",
      orderLinkId: "reject1",
    }),
    (error: any) =>
      error.code === 51008 &&
      error.status === "ORDER_REJECTED" &&
      !error.message.includes("raw"),
  );
});

test("OKX rate-limit cooldown is shared between adapter instances for an account", async () => {
  let requests = 0;
  const transport: typeof fetch = async () => {
    requests++;
    return new Response("", { status: 429 });
  };
  const c = { ...credentials, apiKey: "cooldown-fixture" };
  const a = new OKXAdapter("TESTNET", c, transport);
  const b = new OKXAdapter("TESTNET", c, transport);
  await assert.rejects(
    a.getBalances(),
    (e: any) => e.status === "RATE_LIMITED",
  );
  await assert.rejects(
    b.getBalances(),
    (e: any) => e.status === "RATE_LIMITED",
  );
  assert.equal(requests, 1);
});
