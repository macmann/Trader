import { bybitInterval, okxInterval } from "../../trading/src/timeframes.ts";
import { Decimal } from "decimal.js";
import {
  BybitAdapter,
  ExchangeError,
  type Candle,
} from "../../core/src/index.ts";
import {
  OKXAdapter,
  type ExchangeCredentials,
  type ExchangeAdapter,
} from "./index.ts";
export type ContractPosition = {
  quantity: string;
  direction: "LONG" | "SHORT";
  entryPrice: string;
  liquidationPrice: string;
  leverage: string;
  isolated: boolean;
};
export interface PerpetualAdapter extends ExchangeAdapter {
  contractPositions(): Promise<ContractPosition[]>;
  funding(
    since: number,
  ): Promise<{ id: string; amount: string; time: number }[]>;
  prepare(direction: "LONG" | "SHORT", leverage?: number): Promise<void>;
  availableMargin(): Promise<string>;
  closeOnly: boolean;
}
const dec = (v: unknown) => new Decimal(String(v));
export class PerpetualExchange implements PerpetualAdapter {
  readonly bybit: BybitAdapter;
  readonly okx: OKXAdapter;
  private unit = new Decimal(1);
  private tick = new Decimal("0.01");
  private hedge = false;
  closeOnly = false;
  constructor(
    readonly provider: string,
    readonly symbol: string,
    credentials?: ExchangeCredentials,
    transport: typeof fetch = fetch,
  ) {
    if (!["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol))
      throw Error("UNSUPPORTED_FUTURES_CONTRACT");
    if (!["BYBIT", "BYBIT_EU_TESTNET", "OKX"].includes(provider))
      throw Error("FUTURES_TESTNET_ONLY");
    this.bybit = new BybitAdapter(
      "TESTNET",
      credentials,
      provider === "BYBIT_EU_TESTNET" ? "EU" : "GLOBAL",
    );
    this.okx = new OKXAdapter("TESTNET", credentials, transport);
  }
  get inst() {
    return this.symbol.replace("USDT", "-USDT-SWAP");
  }
  async validateCredentials() {
    return this.provider === "OKX"
      ? this.okx.validateCredentials()
      : this.bybit.validateCredentials();
  }
  async getBalances() {
    return this.provider === "OKX"
      ? this.okx.getBalances()
      : this.bybit.getBalances();
  }
  async availableMargin() {
    if (this.provider === "OKX") {
      const b = await this.okx.request("/api/v5/account/balance", {
        ccy: "USDT",
      });
      const c = b[0]?.details?.find((x: any) => x.ccy === "USDT");
      return String(c?.availBal ?? "NaN");
    }
    const r = await this.bybit.getBalances(),
      c = r.list?.[0]?.coin?.find((x: any) => x.coin === "USDT");
    return dec(c?.walletBalance ?? "NaN")
      .minus(c?.totalPositionIM || 0)
      .minus(c?.totalOrderIM || 0)
      .minus(c?.locked || 0)
      .toFixed();
  }
  async getInstrument(_symbol: string) {
    if (this.provider !== "OKX") {
      const r = await this.bybit.request(
          "/v5/market/instruments-info",
          { category: "linear", symbol: this.symbol },
          "GET",
          false,
        ),
        v = r.list?.[0];
      if (
        v?.settleCoin !== "USDT" ||
        v?.contractType !== "LinearPerpetual" ||
        v?.status !== "Trading"
      )
        throw Error("UNSUPPORTED_FUTURES_CONTRACT");
      return {
        list: [
          {
            ...v,
            lotSizeFilter: {
              basePrecision: v.lotSizeFilter.qtyStep,
              minOrderQty: v.lotSizeFilter.minOrderQty,
              minOrderAmt: v.lotSizeFilter.minNotionalValue,
              maxMarketOrderQty: v.lotSizeFilter.maxMktOrderQty,
              maxLimitOrderQty: v.lotSizeFilter.maxOrderQty,
            },
          },
        ],
      };
    }
    const v = (
      await this.okx.request(
        "/api/v5/public/instruments",
        { instType: "SWAP", instId: this.inst },
        "GET",
        false,
      )
    )[0];
    if (
      v?.ctType !== "linear" ||
      v?.settleCcy !== "USDT" ||
      v?.ctValCcy !== this.symbol.replace(/USDT$/, "") ||
      v?.state !== "live"
    )
      throw Error("UNSUPPORTED_FUTURES_CONTRACT");
    this.tick = dec(v.tickSz);
    if (!this.tick.isFinite() || this.tick.lte(0))
      throw Error("INVALID_CONTRACT_SIZE");
    this.unit = dec(v.ctVal).mul(v.ctMult || 1);
    if (!this.unit.isFinite() || this.unit.lte(0))
      throw Error("INVALID_CONTRACT_SIZE");
    return {
      list: [
        {
          priceFilter: { tickSize: v.tickSz },
          lotSizeFilter: {
            basePrecision: dec(v.lotSz).mul(this.unit).toFixed(),
            minOrderQty: dec(v.minSz).mul(this.unit).toFixed(),
            minOrderAmt: "0",
            maxMarketOrderQty: dec(v.maxMktSz).mul(this.unit).toFixed(),
            maxLimitOrderQty: dec(v.maxLmtSz).mul(this.unit).toFixed(),
          },
        },
      ],
    };
  }
  async getTicker(_symbol: string) {
    const start = Date.now();
    if (this.provider !== "OKX") {
      const r = await this.bybit.request(
        "/v5/market/tickers",
        { category: "linear", symbol: this.symbol },
        "GET",
        false,
      );
      if (Date.now() - start > 15000) throw Error("STALE_FUTURES_MARKET");
      return {
        list: r.list.map((v: any) => ({
          ...v,
          lastPrice: v.markPrice,
          observedAt: Date.now(),
        })),
      };
    }
    const t = (
        await this.okx.request(
          "/api/v5/market/ticker",
          { instId: this.inst },
          "GET",
          false,
        )
      )[0],
      m = (
        await this.okx.request(
          "/api/v5/public/mark-price",
          { instType: "SWAP", instId: this.inst },
          "GET",
          false,
        )
      )[0];
    if (
      !m?.ts ||
      Math.abs(Date.now() - Number(m.ts)) > 45000 ||
      Date.now() - start > 15000
    )
      throw Error("STALE_FUTURES_MARKET");
    return {
      list: [
        {
          lastPrice: m.markPx,
          bid1Price: t?.bidPx,
          ask1Price: t?.askPx,
          observedAt: Number(m.ts),
        },
      ],
    };
  }
  async getCandles(
    _symbol: string,
    interval = "15",
    limit = 200,
  ): Promise<Candle[]> {
    if (this.provider !== "OKX") {
      const r = await this.bybit.request(
        "/v5/market/kline",
        {
          category: "linear",
          symbol: this.symbol,
          interval: bybitInterval(interval),
          limit,
        },
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
    return (
      await this.okx.request(
        "/api/v5/market/candles",
        {
          instId: this.inst,
          bar: okxInterval(interval),
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
        volume: +v[6],
      }))
      .reverse();
  }
  private normalize(v: any) {
    return {
      orderId: v.ordId,
      orderLinkId: v.clOrdId,
      symbol: this.symbol,
      orderStatus:
        (
          {
            live: "New",
            partially_filled: "PartiallyFilled",
            filled: "Filled",
            canceled: "Cancelled",
          } as any
        )[v.state] ?? "UNKNOWN",
      cumExecQty: dec(v.accFillSz || 0)
        .mul(this.unit)
        .toFixed(),
    };
  }
  async getOpenOrders(cursor?: string) {
    if (this.provider !== "OKX")
      return this.bybit.request("/v5/order/realtime", {
        category: "linear",
        symbol: this.symbol,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
    const list = await this.okx.request("/api/v5/trade/orders-pending", {
      instType: "SWAP",
      instId: this.inst,
      limit: 100,
      ...(cursor ? { after: cursor } : {}),
    });
    return {
      list: list.map((v) => this.normalize(v)),
      nextPageCursor: list.length === 100 ? list.at(-1).ordId : undefined,
    };
  }
  async getOrder(client: string, _symbol?: string) {
    if (this.provider !== "OKX")
      return this.bybit.request("/v5/order/history", {
        category: "linear",
        symbol: this.symbol,
        orderLinkId: client,
      });
    return {
      list: (
        await this.okx.request("/api/v5/trade/order", {
          instId: this.inst,
          clOrdId: client,
        })
      ).map((v) => this.normalize(v)),
    };
  }
  async getExecutions(cursor?: string, since?: number, until?: number) {
    if (this.provider !== "OKX") {
      const r = await this.bybit.request("/v5/execution/list", {
        category: "linear",
        symbol: this.symbol,
        execType: "Trade",
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(since ? { startTime: since } : {}),
        ...(until ? { endTime: until } : {}),
      });
      return {
        ...r,
        list: r.list.map((f: any) => ({ ...f, feeCurrency: "USDT" })),
      };
    }
    const list = await this.okx.request("/api/v5/trade/fills-history", {
      instType: "SWAP",
      instId: this.inst,
      limit: 100,
      ...(since ? { begin: since } : {}),
      ...(until ? { end: until } : {}),
      ...(cursor ? { after: cursor } : {}),
    });
    return {
      list: list.map((f: any) => ({
        execId: f.billId,
        orderId: f.ordId,
        ...(f.clOrdId ? { orderLinkId: f.clOrdId } : {}),
        symbol: this.symbol,
        side: f.side === "buy" ? "Buy" : "Sell",
        execQty: dec(f.fillSz).mul(this.unit).toFixed(),
        execPrice: f.fillPx,
        execFee: dec(f.fee).neg().toFixed(),
        feeCurrency: f.feeCcy,
        execTime: f.ts,
        execType: "Trade",
      })),
      nextPageCursor: list.length === 100 ? list.at(-1).billId : undefined,
    };
  }
  async contractPositions(): Promise<ContractPosition[]> {
    if (this.provider !== "OKX") {
      const [a, r] = await Promise.all([
        this.bybit.request("/v5/account/info"),
        this.bybit.request("/v5/position/list", {
          category: "linear",
          symbol: this.symbol,
        }),
      ]);
      if (a.marginMode !== "ISOLATED_MARGIN")
        throw Error("ISOLATED_MARGIN_REQUIRED");
      if (r.list.some((p: any) => p.positionIdx !== 0))
        throw Error("ONE_WAY_POSITION_MODE_REQUIRED");
      return r.list
        .filter((p: any) => dec(p.size || 0).gt(0))
        .map((p: any) => {
          if (p.positionIdx !== 0)
            throw Error("ONE_WAY_POSITION_MODE_REQUIRED");
          return {
            quantity: p.size,
            direction: p.side === "Buy" ? "LONG" : "SHORT",
            entryPrice: p.avgPrice,
            liquidationPrice: p.liqPrice || "0",
            leverage: p.leverage,
            isolated: true,
          };
        });
    }
    const cfg = (await this.okx.request("/api/v5/account/config"))[0];
    if (cfg?.posMode !== "net_mode")
      throw Error("ONE_WAY_POSITION_MODE_REQUIRED");
    this.hedge = false;
    return (
      await this.okx.request("/api/v5/account/positions", {
        instType: "SWAP",
        instId: this.inst,
      })
    )
      .filter((p: any) => !dec(p.pos || 0).isZero())
      .map((p: any) => ({
        quantity: dec(p.pos).abs().mul(this.unit).toFixed(),
        direction: p.posSide === "short" || dec(p.pos).lt(0) ? "SHORT" : "LONG",
        entryPrice: p.avgPx,
        liquidationPrice: p.liqPx || "0",
        leverage: p.lever,
        isolated: p.mgnMode === "isolated",
      }));
  }
  async prepare(direction: "LONG" | "SHORT", leverage = 1) {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 20)
      throw Error("INVALID_LEVERAGE");
    if (this.provider === "OKX") {
      await this.okx.request(
        "/api/v5/account/set-leverage",
        {
          instId: this.inst,
          lever: String(leverage),
          mgnMode: "isolated",
          ...(this.hedge ? { posSide: direction.toLowerCase() } : {}),
        },
        "POST",
      );
      const configured = await this.okx.request(
        "/api/v5/account/leverage-info",
        { instId: this.inst, mgnMode: "isolated" },
      );
      if (
        !configured.length ||
        configured.some(
          (v: any) =>
            !/^\d+(\.\d+)?$/.test(String(v.lever)) ||
            !dec(v.lever).eq(leverage),
        )
      )
        throw Error("LEVERAGE_VERIFICATION_FAILED");
      return;
    }
    try {
      await this.bybit.request(
        "/v5/position/set-leverage",
        {
          category: "linear",
          symbol: this.symbol,
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        },
        "POST",
      );
    } catch (e) {
      if (!(e instanceof ExchangeError) || e.code !== 110043) throw e;
    }
    const configured = await this.bybit.request("/v5/position/list", {
      category: "linear",
      symbol: this.symbol,
    });
    if (
      !configured.list?.length ||
      configured.list.some(
        (v: any) =>
          v.positionIdx !== 0 ||
          !/^\d+(\.\d+)?$/.test(String(v.leverage)) ||
          !dec(v.leverage).eq(leverage),
      )
    )
      throw Error("LEVERAGE_VERIFICATION_FAILED");
  }
  async funding(since: number) {
    const result: { id: string; amount: string; time: number }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      if (this.provider !== "OKX") {
        const r = await this.bybit.request("/v5/account/transaction-log", {
          accountType: "UNIFIED",
          category: "linear",
          currency: "USDT",
          type: "SETTLEMENT",
          startTime: since,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        for (const v of r.list)
          if (v.symbol === this.symbol)
            result.push({
              id: v.id,
              amount: v.funding,
              time: Number(v.transactionTime),
            });
        if (!r.nextPageCursor) return result;
        if (r.nextPageCursor === cursor)
          throw Error("FUNDING_PAGINATION_INVALID");
        cursor = r.nextPageCursor;
      } else {
        const list = await this.okx.request("/api/v5/account/bills", {
          instType: "SWAP",
          instId: this.inst,
          type: 8,
          begin: since,
          limit: 100,
          ...(cursor ? { after: cursor } : {}),
        });
        for (const v of list)
          if (v.instId === this.inst && v.ccy === "USDT")
            result.push({ id: v.billId, amount: v.balChg, time: Number(v.ts) });
        if (list.length < 100) return result;
        const next = list.at(-1).billId;
        if (next === cursor) throw Error("FUNDING_PAGINATION_INVALID");
        cursor = next;
      }
    }
    throw Error("FUNDING_PAGINATION_LIMIT");
  }
  async placeOrder(p: Parameters<BybitAdapter["placeOrder"]>[0]) {
    if (p.symbol !== this.symbol) throw Error("FUTURES_SYMBOL_MISMATCH");
    if (p.orderType && p.orderType !== "Market")
      throw Error("FUTURES_MARKET_ORDERS_ONLY");
    if (this.provider !== "OKX")
      return this.bybit.request(
        "/v5/order/create",
        {
          category: "linear",
          symbol: this.symbol,
          side: p.side,
          qty: p.qty,
          orderType: "Market",
          orderLinkId: p.orderLinkId,
          positionIdx: 0,
          reduceOnly: this.closeOnly,
          slippageToleranceType: "Percent",
          slippageTolerance: "0.3",
        },
        "POST",
      );
    const quote = (await this.getTicker(this.symbol)).list[0];
    const raw = dec(p.side === "Buy" ? quote.ask1Price : quote.bid1Price).mul(
      p.side === "Buy" ? "1.003" : "0.997",
    );
    if (!raw.isFinite() || raw.lte(0)) throw Error("STALE_FUTURES_MARKET");
    const protectedPrice = (
      p.side === "Buy" ? raw.div(this.tick).floor() : raw.div(this.tick).ceil()
    )
      .mul(this.tick)
      .toFixed();
    const direction = this.closeOnly
      ? p.side === "Buy"
        ? "short"
        : "long"
      : p.side === "Buy"
        ? "long"
        : "short";
    const r = (
      await this.okx.request(
        "/api/v5/trade/order",
        {
          instId: this.inst,
          tdMode: "isolated",
          side: p.side.toLowerCase(),
          posSide: this.hedge ? direction : "net",
          ordType: "ioc",
          px: protectedPrice,
          sz: dec(p.qty).div(this.unit).toFixed(),
          clOrdId: p.orderLinkId,
          ...(!this.hedge ? { reduceOnly: this.closeOnly } : {}),
        },
        "POST",
      )
    )[0];
    if (r?.sCode !== "0")
      throw new ExchangeError(Number(r?.sCode || 0), "ORDER_REJECTED");
    return { orderId: r.ordId };
  }
  async cancelOrder(_symbol: string, id: string) {
    if (this.provider !== "OKX")
      return this.bybit.request(
        "/v5/order/cancel",
        { category: "linear", symbol: this.symbol, orderId: id },
        "POST",
      );
    const r = (
      await this.okx.request(
        "/api/v5/trade/cancel-order",
        { instId: this.inst, ordId: id },
        "POST",
      )
    )[0];
    if (r?.sCode !== "0") throw Error("CANCELLATION_UNCONFIRMED");
    return r;
  }
}
