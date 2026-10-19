import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHmac,
} from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
export const botConfig = z
  .object({
    capital: z.number().positive().max(1000000).default(100),
    maxTrade: z.number().positive().default(20),
    stopLossPct: z.number().positive().max(50).default(2),
    takeProfitPct: z.number().positive().max(100).default(4),
    dailyLoss: z.number().positive().default(5),
    maxTrades: z.number().int().positive().max(100).default(10),
    maxDrawdownPct: z.number().positive().max(50).default(10),
    maxConsecutiveLosses: z.number().int().positive().default(3),
  })
  .refine(
    (c) => c.maxTrade <= c.capital,
    "Maximum trade must not exceed capital",
  );
export type BotConfig = z.infer<typeof botConfig>;
export function encrypt(value: unknown, key: string, context: string): string {
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw Error("APP_ENCRYPTION_KEY must be 32 bytes in hex");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
export function decrypt<T>(value: string, key: string, context: string): T {
  const b = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      b.subarray(0, 12),
    );
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
  );
}
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export function ema(values: number[], period: number): number[] {
  let v = values[0];
  return values.map(
    (n) => (v = (n * 2) / (period + 1) + v * (1 - 2 / (period + 1))),
  );
}
export function evaluate(c: Candle[]): {
  direction: "LONG" | "EXIT" | "NONE";
  reasons: string[];
} {
  if (c.length < 50)
    return { direction: "NONE", reasons: ["INSUFFICIENT_CANDLES"] };
  const close = c.map((x) => x.close),
    fast = ema(close, 9),
    slow = ema(close, 21),
    i = c.length - 1;
  let gain = 0,
    loss = 0;
  for (let j = i - 13; j <= i; j++) {
    const d = close[j] - close[j - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  const rsi =
      loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss),
    volume = c.slice(i - 20, i).reduce((a, v) => a + v.volume, 0) / 20;
  if (fast[i] < slow[i])
    return { direction: "EXIT", reasons: ["EMA_TREND_REVERSED"] };
  if (
    fast[i - 1] <= slow[i - 1] &&
    fast[i] > slow[i] &&
    rsi >= 50 &&
    rsi <= 70 &&
    c[i].volume > volume &&
    c[i].close > c[i - 1].high
  )
    return {
      direction: "LONG",
      reasons: [
        "EMA_CROSS",
        "RSI_CONFIRMED",
        "VOLUME_CONFIRMED",
        "STRUCTURE_CONFIRMED",
      ],
    };
  return { direction: "NONE", reasons: ["WAIT_FOR_CONFIRMATION"] };
}
export function risk(input: {
  config: BotConfig;
  status: string;
  environment: string;
  liveEnabled: boolean;
  connected: boolean;
  fresh: boolean;
  reconciled: boolean;
  globalStop: boolean;
  exposure: number;
  dailyPnl: number;
  trades: number;
  drawdownPct: number;
  consecutiveLosses: number;
  available: number;
  spreadPct: number;
  allowScaleIn?: boolean;
}): string[] {
  if (
    ![
      input.exposure,
      input.dailyPnl,
      input.trades,
      input.drawdownPct,
      input.consecutiveLosses,
      input.available,
      input.spreadPct,
    ].every(Number.isFinite)
  )
    return ["INVALID_RISK_STATE"];
  const r: string[] = [];
  if (input.status !== "RUNNING") r.push("BOT_NOT_RUNNING");
  if (input.environment === "LIVE" && !input.liveEnabled)
    r.push("LIVE_DISABLED");
  if (!input.connected) r.push("EXCHANGE_DISCONNECTED");
  if (!input.fresh) r.push("STALE_MARKET_DATA");
  if (!input.reconciled) r.push("RECONCILIATION_REQUIRED");
  if (input.globalStop) r.push("GLOBAL_STOP");
  if (input.exposure > 0 && !input.allowScaleIn) r.push("ALREADY_POSITIONED");
  if (input.exposure + input.config.maxTrade > input.config.capital)
    r.push("ALLOCATION_EXCEEDED");
  if (input.available < input.config.maxTrade) r.push("INSUFFICIENT_BALANCE");
  if (input.dailyPnl <= -input.config.dailyLoss) r.push("DAILY_LOSS_LIMIT");
  if (input.trades >= input.config.maxTrades) r.push("DAILY_TRADE_LIMIT");
  if (input.drawdownPct >= input.config.maxDrawdownPct)
    r.push("DRAWDOWN_LIMIT");
  if (input.consecutiveLosses >= input.config.maxConsecutiveLosses)
    r.push("CONSECUTIVE_LOSS_LIMIT");
  if (input.spreadPct > 0.3) r.push("SPREAD_TOO_WIDE");
  return r;
}
export function quantize(value: string, step: string): string {
  return new Decimal(value).div(step).floor().mul(step).toFixed();
}
export type Credentials = { apiKey: string; apiSecret: string };
export class ExchangeError extends Error {
  constructor(
    public code: number,
    public status: string,
  ) {
    super(status);
  }
}
export class BybitAdapter {
  readonly base: string;
  constructor(
    readonly environment: "TESTNET" | "LIVE",
    private credentials?: Credentials,
  ) {
    this.base =
      environment === "TESTNET"
        ? "https://api-testnet.bybit.com"
        : "https://api.bybit.com";
  }
  async request(
    path: string,
    params: Record<string, unknown> = {},
    method: "GET" | "POST" = "GET",
    auth = true,
  ): Promise<any> {
    const payload =
      method === "GET"
        ? new URLSearchParams(
            Object.entries(params).map(([k, v]) => [k, String(v)]),
          ).toString()
        : JSON.stringify(params);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (auth) {
      if (!this.credentials) throw Error("Credentials required");
      const time = String(Date.now()),
        window = "5000";
      Object.assign(headers, {
        "X-BAPI-API-KEY": this.credentials.apiKey,
        "X-BAPI-TIMESTAMP": time,
        "X-BAPI-RECV-WINDOW": window,
        "X-BAPI-SIGN": createHmac("sha256", this.credentials.apiSecret)
          .update(time + this.credentials.apiKey + window + payload)
          .digest("hex"),
      });
    }
    const res = await fetch(
      this.base + path + (method === "GET" && payload ? "?" + payload : ""),
      {
        method,
        headers,
        body: method === "POST" ? payload : undefined,
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok)
      throw new ExchangeError(
        res.status,
        res.status === 403
          ? "REGION_RESTRICTED"
          : res.status === 429
            ? "RATE_LIMITED"
            : "EXCHANGE_HTTP_ERROR",
      );
    const body = (await res.json()) as any;
    if (body.retCode !== 0)
      throw new ExchangeError(
        body.retCode,
        [10003, 10004, 10005, 33004].includes(body.retCode)
          ? "INVALID_CREDENTIALS"
          : body.retCode === 10006
            ? "RATE_LIMITED"
            : "EXCHANGE_ERROR",
      );
    return body.result;
  }
  async validateCredentials() {
    const r = await this.request("/v5/user/query-api");
    const p = r.permissions ?? {};
    const dangerous =
      (p.Wallet ?? []).some((x: string) => /withdraw|transfer/i.test(x)) ||
      (p.Fund ?? []).length > 0;
    if (dangerous || !(p.Spot ?? []).includes("SpotTrade") || r.readOnly !== 0)
      throw new ExchangeError(0, "PERMISSION_ERROR");
    return {
      readAccount: true,
      trading: true,
      withdrawals: false,
      ipBinding: r.ips ?? [],
    };
  }
  getBalances() {
    return this.request("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
  }
  getInstrument(symbol: string) {
    return this.request(
      "/v5/market/instruments-info",
      { category: "spot", symbol },
      "GET",
      false,
    );
  }
  getTicker(symbol: string) {
    return this.request(
      "/v5/market/tickers",
      { category: "spot", symbol },
      "GET",
      false,
    );
  }
  async getCandles(
    symbol: string,
    interval = "15",
    limit = 100,
  ): Promise<Candle[]> {
    const r = await this.request(
      "/v5/market/kline",
      { category: "spot", symbol, interval, limit },
      "GET",
      false,
    );
    return r.list
      .map((v: string[]) => ({
        time: +v[0],
        open: +v[1],
        high: +v[2],
        low: +v[3],
        close: +v[4],
        volume: +v[5],
      }))
      .reverse();
  }
  getOpenOrders(cursor?: string) {
    return this.request("/v5/order/realtime", {
      category: "spot",
      openOnly: 0,
      ...(cursor ? { cursor } : {}),
      limit: 50,
    });
  }
  async getOrder(clientId: string) {
    const result = await this.request("/v5/order/realtime", {
      category: "spot",
      orderLinkId: clientId,
    });
    return result.list?.length
      ? result
      : this.request("/v5/order/history", {
          category: "spot",
          orderLinkId: clientId,
        });
  }
  getExecutions(cursor?: string, startTime?: number, endTime?: number) {
    return this.request("/v5/execution/list", {
      category: "spot",
      limit: 100,
      ...(cursor ? { cursor } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    });
  }
  placeOrder(p: {
    symbol: string;
    side: "Buy" | "Sell";
    qty: string;
    orderLinkId: string;
    orderType?: "Market" | "Limit";
    price?: string;
    timeInForce?: "GTC" | "PostOnly";
  }) {
    const { orderType = "Market", price, timeInForce, ...common } = p;
    if (
      orderType === "Limit" &&
      (!price || !Number.isFinite(Number(price)) || Number(price) <= 0)
    )
      throw Error("LIMIT_PRICE_REQUIRED");
    return this.request(
      "/v5/order/create",
      {
        category: "spot",
        ...common,
        orderType,
        ...(orderType === "Limit"
          ? { price, timeInForce: timeInForce ?? "PostOnly" }
          : {
              marketUnit: "baseCoin",
              slippageToleranceType: "Percent",
              slippageTolerance: "0.3",
            }),
      },
      "POST",
    );
  }
  cancelOrder(symbol: string, orderId: string) {
    return this.request(
      "/v5/order/cancel",
      { category: "spot", symbol, orderId },
      "POST",
    );
  }
}
