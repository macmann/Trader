import { createHmac } from "node:crypto";
import {
  BybitAdapter,
  ExchangeError,
  type Credentials,
  type Candle,
} from "../../core/src/index.ts";
export type ExchangeCredentials = Credentials & { passphrase?: string };
export type ExchangeAdapter = Pick<
  BybitAdapter,
  | "validateCredentials"
  | "getBalances"
  | "getInstrument"
  | "getTicker"
  | "getCandles"
  | "getOpenOrders"
  | "getOrder"
  | "getExecutions"
  | "placeOrder"
  | "cancelOrder"
>;
export const providers = [
  { id: "BYBIT", name: "Bybit Global Testnet (.com)", environment: "TESTNET" },
  {
    id: "BYBIT_EU_TESTNET",
    name: "Bybit EU Testnet (.eu)",
    environment: "TESTNET",
  },
  { id: "OKX", name: "OKX Demo", environment: "TESTNET" },
  {
    id: "BYBIT_EU",
    name: "Bybit EU (LIVE, read-only preview)",
    environment: "LIVE",
    readOnly: true,
  },
] as const;
export function instrumentId(symbol: string) {
  if (!["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol))
    throw Error("UNSUPPORTED_SYMBOL");
  return symbol.replace("USDT", "-USDT");
}
function normalizedOrder(o: any) {
  return {
    orderId: o.ordId,
    orderLinkId: o.clOrdId,
    symbol: String(o.instId).replace("-", ""),
    orderStatus:
      (
        {
          live: "New",
          partially_filled: "PartiallyFilled",
          filled: "Filled",
          canceled: "Cancelled",
          mmp_canceled: "Cancelled",
        } as Record<string, string>
      )[o.state] ?? "UNKNOWN",
    cumExecQty: o.accFillSz,
  };
}
export class OKXAdapter implements ExchangeAdapter {
  constructor(
    readonly environment: "TESTNET" | "LIVE",
    private credentials?: ExchangeCredentials,
    private transport: typeof fetch = fetch,
  ) {
    if (environment !== "TESTNET") throw new ExchangeError(0, "LIVE_DISABLED");
  }
  async request(
    path: string,
    params: Record<string, unknown> = {},
    method: "GET" | "POST" = "GET",
    auth = true,
  ): Promise<any[]> {
    const query = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ).toString(),
      requestPath = path + (method === "GET" && query ? "?" + query : ""),
      body = method === "POST" ? JSON.stringify(params) : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-simulated-trading": "1",
    };
    if (auth) {
      const c = this.credentials;
      if (!c?.passphrase) throw new ExchangeError(0, "INVALID_CREDENTIALS");
      const ts = new Date().toISOString();
      Object.assign(headers, {
        "OK-ACCESS-KEY": c.apiKey,
        "OK-ACCESS-PASSPHRASE": c.passphrase,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-SIGN": createHmac("sha256", c.apiSecret)
          .update(ts + method + requestPath + body)
          .digest("base64"),
      });
    }
    const r = await this.transport("https://www.okx.com" + requestPath, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new ExchangeError(
        r.status,
        r.status === 403
          ? "REGION_RESTRICTED"
          : r.status === 429
            ? "RATE_LIMITED"
            : "EXCHANGE_HTTP_ERROR",
      );
    const result = (await r.json()) as any;
    if (result.code !== "0")
      throw new ExchangeError(
        Number(result.code),
        ["50110", "50111", "50113", "50114"].includes(result.code)
          ? "INVALID_CREDENTIALS"
          : "EXCHANGE_ERROR",
      );
    if (!Array.isArray(result.data))
      throw new ExchangeError(0, "EXCHANGE_RESPONSE_INVALID");
    return result.data;
  }
  async validateCredentials() {
    const config = (await this.request("/api/v5/account/config"))[0],
      perm = String(config?.perm ?? "").split(",");
    if (
      !perm.includes("read_only") ||
      !perm.includes("trade") ||
      perm.some((p) => !["read_only", "trade"].includes(p))
    )
      throw new ExchangeError(0, "PERMISSION_ERROR");
    await this.getBalances();
    return {
      readAccount: true,
      trading: true,
      withdrawals: false,
      ipBinding: [],
    };
  }
  async getBalances() {
    const d = (await this.request("/api/v5/account/balance"))[0];
    return {
      list: [
        {
          coin: (d?.details ?? []).map((c: any) => ({
            coin: c.ccy,
            walletBalance: c.cashBal,
            availableBalance: c.availBal,
          })),
        },
      ],
    };
  }
  async getInstrument(symbol: string) {
    const d = (
      await this.request(
        "/api/v5/public/instruments",
        { instType: "SPOT", instId: instrumentId(symbol) },
        "GET",
        false,
      )
    )[0];
    if (!d || d.state !== "live")
      throw new ExchangeError(0, "INSTRUMENT_UNAVAILABLE");
    return {
      list: [
        {
          symbol,
          priceFilter: { tickSize: d.tickSz },
          lotSizeFilter: {
            basePrecision: d.lotSz,
            minOrderQty: d.minSz,
            minOrderAmt: "0",
            maxMarketOrderQty: d.maxMktSz,
            maxLimitOrderQty: d.maxLmtSz,
            ...(d.maxMktAmt ? { maxOrderAmt: d.maxMktAmt } : {}),
          },
        },
      ],
    };
  }
  async getTicker(symbol: string) {
    const d = (
      await this.request(
        "/api/v5/market/ticker",
        { instId: instrumentId(symbol) },
        "GET",
        false,
      )
    )[0];
    return {
      list: [
        {
          lastPrice: d?.last,
          bid1Price: d?.bidPx,
          ask1Price: d?.askPx,
          ts: d?.ts,
        },
      ],
    };
  }
  async getCandles(
    symbol: string,
    interval = "15",
    limit = 100,
  ): Promise<Candle[]> {
    if (!["15", "30", "60"].includes(interval))
      throw Error("UNSUPPORTED_TIMEFRAME");
    return (
      await this.request(
        "/api/v5/market/candles",
        {
          instId: instrumentId(symbol),
          bar: interval === "60" ? "1H" : `${interval}m`,
          limit,
        },
        "GET",
        false,
      )
    )
      .filter((v: any) => v[8] === "1")
      .map((v: any) => ({
        time: +v[0],
        open: +v[1],
        high: +v[2],
        low: +v[3],
        close: +v[4],
        volume: +v[5],
      }))
      .reverse();
  }
  async getOpenOrders(cursor?: string) {
    const d = await this.request("/api/v5/trade/orders-pending", {
      instType: "SPOT",
      limit: 100,
      ...(cursor ? { after: cursor } : {}),
    });
    return {
      list: d.map(normalizedOrder),
      ...(d.length === 100 ? { nextPageCursor: d.at(-1).ordId } : {}),
    };
  }
  async getOrder(clientId: string, symbol?: string) {
    if (!symbol) throw Error("SYMBOL_REQUIRED");
    try {
      return {
        list: (
          await this.request("/api/v5/trade/order", {
            instId: instrumentId(symbol),
            clOrdId: clientId,
          })
        ).map(normalizedOrder),
      };
    } catch (e) {
      if (e instanceof ExchangeError && e.code === 51603) return { list: [] };
      throw e;
    }
  }
  async getExecutions(cursor?: string, startTime?: number, endTime?: number) {
    const d = await this.request("/api/v5/trade/fills-history", {
      instType: "SPOT",
      limit: 100,
      ...(cursor ? { after: cursor } : {}),
      ...(startTime !== undefined ? { begin: startTime } : {}),
      ...(endTime !== undefined ? { end: endTime } : {}),
    });
    return {
      list: d.map((f: any) => {
        if (Number(f.fee) > 0)
          throw new ExchangeError(0, "FEE_REBATE_UNSUPPORTED");
        return {
          execId: f.billId ?? f.tradeId,
          orderId: f.ordId,
          orderLinkId: f.clOrdId ?? "",
          execQty: f.fillSz,
          execPrice: f.fillPx,
          execTime: f.ts,
          execFee: String(-Number(f.fee)),
          feeCurrency: f.feeCcy,
        };
      }),
      ...(d.length === 100 ? { nextPageCursor: d.at(-1).billId } : {}),
    };
  }
  async placeOrder(p: Parameters<BybitAdapter["placeOrder"]>[0]) {
    if (!/^[a-zA-Z0-9]{1,32}$/.test(p.orderLinkId))
      throw Error("INVALID_CLIENT_ID");
    const limit = p.orderType === "Limit";
    if (limit && (!p.price || Number(p.price) <= 0))
      throw Error("LIMIT_PRICE_REQUIRED");
    const result = (
      await this.request(
        "/api/v5/trade/order",
        {
          instId: instrumentId(p.symbol),
          tdMode: "cash",
          clOrdId: p.orderLinkId,
          side: p.side.toLowerCase(),
          ordType: limit
            ? p.timeInForce === "PostOnly"
              ? "post_only"
              : "limit"
            : "market",
          sz: p.qty,
          ...(limit ? { px: p.price } : { tgtCcy: "base_ccy" }),
        },
        "POST",
      )
    )[0];
    if (result?.sCode !== "0" || !result.ordId)
      throw new ExchangeError(Number(result?.sCode ?? 0), "ORDER_REJECTED");
    return { orderId: result.ordId };
  }
  async cancelOrder(symbol: string, id: string) {
    const r = (
      await this.request(
        "/api/v5/trade/cancel-order",
        { instId: instrumentId(symbol), ordId: id },
        "POST",
      )
    )[0];
    if (r?.sCode !== "0")
      throw new ExchangeError(
        Number(r?.sCode ?? 0),
        "CANCELLATION_UNCONFIRMED",
      );
    return r;
  }
}
export function exchangeAdapter(
  provider: string,
  environment: "TESTNET" | "LIVE",
  credentials?: ExchangeCredentials,
): ExchangeAdapter {
  if (provider === "BYBIT_EU") {
    if (environment !== "LIVE")
      throw new ExchangeError(0, "BYBIT_EU_REQUIRES_LIVE_ENVIRONMENT");
    return new BybitAdapter(environment, credentials, "EU");
  }
  if (environment !== "TESTNET") throw new ExchangeError(0, "LIVE_DISABLED");
  if (provider === "BYBIT") return new BybitAdapter(environment, credentials);
  if (provider === "BYBIT_EU_TESTNET")
    return new BybitAdapter(environment, credentials, "EU");
  if (provider === "OKX") return new OKXAdapter(environment, credentials);
  throw new ExchangeError(0, "UNSUPPORTED_EXCHANGE");
}

export function bybitTestnetEndpoints(provider: "BYBIT" | "BYBIT_EU_TESTNET") {
  if (provider !== "BYBIT" && provider !== "BYBIT_EU_TESTNET")
    throw new ExchangeError(0, "UNSUPPORTED_TESTNET_EXCHANGE");
  const domain = provider === "BYBIT_EU_TESTNET" ? "bybit.eu" : "bybit.com";
  return {
    public: `wss://stream-testnet.${domain}/v5/public/spot`,
    private: `wss://stream-testnet.${domain}/v5/private`,
  };
}
