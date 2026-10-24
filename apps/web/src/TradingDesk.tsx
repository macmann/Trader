import { StrategyFields, strategyFields } from "./StrategyCreator.tsx";
import React, { useEffect, useState } from "react";
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
type Bot = {
  id: string;
  name: string;
  symbol: string;
  status: string;
  strategy_version: string;
  config: any;
  advanced_config: any;
  timeframe?: string;
  custom_strategy_id?: string | null;
  ai_strategy_config?: any;
};
export function TradingDesk({
  bots,
  request,
  refreshBots,
}: {
  bots: Bot[];
  request: Request;
  refreshBots: () => Promise<void>;
}) {
  const [portfolio, setPortfolio] = useState<any>(null),
    [options, setOptions] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const bot = bots.find((b) => b.id === selected) ?? bots[0];
  async function load() {
    const [p, o] = await Promise.all([
      request("/portfolio"),
      request("/trading/options"),
    ]);
    setPortfolio(p);
    setOptions(o);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const submit =
    (fn: (data: FormData) => Promise<void>) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      void run(() => fn(data));
    };
  const fmt = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value ?? 0);
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Portfolio controls</h2>
          <p className="muted">
            Account for all bots, pairs and outstanding buy intents.
          </p>
        </div>
        <button disabled={busy} onClick={() => void run(load)}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="message error" role="alert">
          {error.replaceAll("_", " ")}
        </div>
      )}
      {notice && (
        <div className="message" role="status">
          {notice}
        </div>
      )}
      {portfolio && (
        <>
          <div className="metrics">
            {[
              ["Configured allocation", fmt(portfolio.allocated)],
              ["Tracked position cost", fmt(portfolio.exposure)],
              ["Pending buy reservations", fmt(portfolio.reserved)],
              ["Open / reserved positions", String(portfolio.openPositions)],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {portfolio.unknownPending && (
            <div className="message error">
              An order has unknown reserved exposure. New entries remain blocked
              until reconciliation.
            </div>
          )}
          <section className="panel">
            <h2>Workspace limits</h2>
            <p className="muted">
              Limits apply across bots and connections. They cannot be lowered
              below existing configured allocations or open positions.
            </p>
            <form
              key={JSON.stringify(portfolio.limits)}
              onSubmit={submit(async (f) => {
                await request(
                  "/portfolio/limits",
                  "PATCH",
                  Object.fromEntries(
                    [
                      "maxTotalAllocation",
                      "maxConnectionAllocation",
                      "maxSymbolAllocation",
                      "maxOpenPositions",
                    ].map((k) => [k, Number(f.get(k))]),
                  ),
                );
                setNotice("Portfolio limits saved.");
              })}
            >
              <div className="form-grid">
                {[
                  [
                    "maxTotalAllocation",
                    "Total allocation / exposure ceiling ($)",
                  ],
                  ["maxConnectionAllocation", "Per-connection ceiling ($)"],
                  ["maxSymbolAllocation", "Per-pair ceiling ($)"],
                  [
                    "maxOpenPositions",
                    "Maximum open or reserved bot positions",
                  ],
                ].map(([name, label]) => (
                  <label key={name}>
                    {label}
                    <input
                      name={name}
                      type="number"
                      min="1"
                      step={name === "maxOpenPositions" ? "1" : "0.01"}
                      defaultValue={portfolio.limits[name]}
                      required
                    />
                  </label>
                ))}
              </div>
              <button disabled={busy}>Save workspace limits</button>
            </form>
            <p className="muted">{portfolio.note}</p>
          </section>
        </>
      )}
      <div className="section-heading ai-heading">
        <h2>Advanced bot configuration</h2>
        {bots.length > 0 && (
          <select
            className="bot-selector"
            value={bot?.id ?? ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setPreview(null);
            }}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.symbol}
              </option>
            ))}
          </select>
        )}
      </div>
      {!bot ? (
        <section className="panel empty">
          <p>
            Create a bot to configure a pair, strategy, sizing and protection
            rules.
          </p>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="section-heading">
              <h2>{bot.name}</h2>
              <span className="badge">{bot.status}</span>
            </div>
            <p className="muted">
              Stop the bot and resolve any open position or order before
              changing configuration. Spot only; derivatives are unsupported.
            </p>
            <form
              key={
                bot.id +
                JSON.stringify(bot.advanced_config) +
                JSON.stringify(bot.config) +
                bot.strategy_version +
                bot.symbol
              }
              onSubmit={submit(async (f) => {
                const advanced: any = {
                  ...bot.advanced_config,
                  sizing: f.get("sizing"),
                  entryType: f.get("entryType"),
                  limitTimeInForce: f.get("limitTimeInForce"),
                };
                for (const key of [
                  "riskPerTradePct",
                  "trailingStopPct",
                  "breakEvenTriggerPct",
                  "breakEvenOffsetPct",
                  "limitOffsetPct",
                  "limitTimeToLiveMinutes",
                  "dcaStepPct",
                  "dcaMaxEntries",
                  "dcaIntervalMinutes",
                  "gridLevels",
                ])
                  advanced[key] = Number(f.get(key));
                for (const key of ["gridLower", "gridUpper"])
                  advanced[key] = f.get(key) ? Number(f.get(key)) : null;
                await request(`/bots/${bot.id}/config`, "PATCH", {
                  symbol: f.get("symbol"),
                  strategyVersion: f.get("strategyVersion"),
                  ...strategyFields(f),
                  config: {
                    ...bot.config,
                    ...Object.fromEntries(
                      [
                        "capital",
                        "maxTrade",
                        "stopLossPct",
                        "takeProfitPct",
                        "dailyLoss",
                        "maxTrades",
                        "maxDrawdownPct",
                        "maxConsecutiveLosses",
                      ].map((k) => [k, Number(f.get("base_" + k))]),
                    ),
                  },
                  advancedConfig: advanced,
                });
                await refreshBots();
                setPreview(null);
                setNotice("Bot configuration saved.");
              })}
            >
              <div className="form-grid">
                {[
                  ["capital", "Capital allocation ($)", 100],
                  ["maxTrade", "Maximum trade value ($)", 20],
                  ["stopLossPct", "Initial stop loss (%)", 2],
                  ["takeProfitPct", "Take profit (%)", 4],
                  ["dailyLoss", "Daily loss ceiling ($)", 5],
                  ["maxTrades", "Maximum trades per day", 10],
                  ["maxDrawdownPct", "Drawdown ceiling (%)", 10],
                  ["maxConsecutiveLosses", "Consecutive loss ceiling", 3],
                ].map(([name, label, fallback]) => (
                  <label key={String(name)}>
                    {label}
                    <input
                      name={"base_" + name}
                      type="number"
                      min={
                        ["maxTrades", "maxConsecutiveLosses"].includes(
                          String(name),
                        )
                          ? "1"
                          : "0.01"
                      }
                      step={
                        ["maxTrades", "maxConsecutiveLosses"].includes(
                          String(name),
                        )
                          ? "1"
                          : "0.01"
                      }
                      defaultValue={bot.config?.[String(name)] ?? fallback}
                      required
                    />
                  </label>
                ))}
                <label>
                  Spot pair
                  <select name="symbol" defaultValue={bot.symbol}>
                    {(
                      options?.symbols ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
                    ).map((s: string) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <StrategyFields
                  key={bot.id}
                  request={request}
                  bot={bot}
                  strategies={options?.strategies}
                />
                <label>
                  Position sizing
                  <select
                    name="sizing"
                    defaultValue={bot.advanced_config?.sizing ?? "FIXED"}
                  >
                    <option value="FIXED">Fixed maximum trade</option>
                    <option value="RISK_PERCENT">
                      Risk per trade / stop distance
                    </option>
                  </select>
                </label>
                <label>
                  Limit time in force
                  <select
                    name="limitTimeInForce"
                    defaultValue={
                      bot.advanced_config?.limitTimeInForce ?? "PostOnly"
                    }
                  >
                    <option value="PostOnly">Post only</option>
                    <option value="GTC">Good until cancelled</option>
                  </select>
                </label>
                <label>
                  Entry type
                  <select
                    name="entryType"
                    defaultValue={bot.advanced_config?.entryType ?? "MARKET"}
                  >
                    <option value="MARKET">Market</option>
                    <option value="LIMIT">Limit · expiring order</option>
                  </select>
                </label>
                {[
                  ["riskPerTradePct", "Risk per trade (%)", 1],
                  ["trailingStopPct", "Trailing stop (%) · 0 disables", 0],
                  [
                    "breakEvenTriggerPct",
                    "Break-even activation gain (%) · 0 disables",
                    0,
                  ],
                  ["breakEvenOffsetPct", "Break-even offset (%)", 0],
                  ["limitOffsetPct", "Limit discount (%)", 0.1],
                  ["limitTimeToLiveMinutes", "Limit lifetime (minutes)", 15],
                  ["dcaStepPct", "DCA price decline per entry (%)", 2],
                  ["dcaMaxEntries", "Maximum DCA entries", 3],
                  ["dcaIntervalMinutes", "Minimum DCA interval (minutes)", 60],
                  ["gridLower", "Grid lower price", null],
                  ["gridUpper", "Grid upper price", null],
                  ["gridLevels", "Grid levels", 5],
                ].map(([name, label, defaultValue]) => (
                  <label key={String(name)}>
                    {label}
                    <input
                      name={String(name)}
                      type="number"
                      min="0"
                      step={
                        [
                          "dcaMaxEntries",
                          "limitTimeToLiveMinutes",
                          "dcaIntervalMinutes",
                          "gridLevels",
                        ].includes(String(name))
                          ? "1"
                          : "0.01"
                      }
                      defaultValue={
                        bot.advanced_config?.[String(name)] ??
                        defaultValue ??
                        ""
                      }
                    />
                  </label>
                ))}
              </div>
              <button
                disabled={
                  busy ||
                  ["RUNNING", "STARTING", "STOPPING"].includes(bot.status)
                }
              >
                Save stopped-bot configuration
              </button>
            </form>
          </section>
          <section className="panel note">
            <h3>Hypothetical planning</h3>
            <p className="muted">
              This preview never places or reserves an order. The worker
              supports limit entries, bounded DCA and grid accumulation when
              Testnet execution is enabled. Trend/breakout entry evaluation
              needs closed candles; this simple form supplies a price scenario
              only.
            </p>
            <form
              onSubmit={submit(async (f) => {
                const value = await request(`/bots/${bot.id}/preview`, "POST", {
                  price: Number(f.get("price")),
                  availableBalance: Number(f.get("availableBalance")),
                  quantityStep: String(f.get("quantityStep")),
                  minNotional: Number(f.get("minNotional")),
                });
                setPreview(value);
              })}
            >
              <div className="form-grid">
                <label>
                  Hypothetical price
                  <input
                    name="price"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                  />
                </label>
                <label>
                  Hypothetical available quote balance ($)
                  <input
                    name="availableBalance"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue="100"
                    required
                  />
                </label>
                <label>
                  Hypothetical quantity step
                  <input name="quantityStep" defaultValue="0.000001" required />
                </label>
                <label>
                  Hypothetical minimum order value ($)
                  <input
                    name="minNotional"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue="5"
                    required
                  />
                </label>
              </div>
              <button disabled={busy}>Preview plan</button>
            </form>
            {preview && (
              <div className="preview-result" role="status">
                <span className="badge">SIMULATION ONLY · NO ORDERS</span>
                <h3>
                  {preview.symbol} · {preview.signal.direction}
                </h3>
                <p>{preview.signal.reasons.join(" · ").replaceAll("_", " ")}</p>
                {preview.proposal && (
                  <p>
                    Proposed {preview.proposal.side} ·{" "}
                    {preview.proposal.orderType} · {preview.proposal.quantity}{" "}
                    units · {fmt(preview.proposal.notional)}
                    {preview.proposal.limitPrice
                      ? ` · Limit ${preview.proposal.limitPrice}`
                      : ""}
                  </p>
                )}
                {preview.protection.entry > 0 && (
                  <p>
                    Software stop {preview.protection.stopPrice.toFixed(4)} ·
                    Take profit {preview.protection.takeProfitPrice.toFixed(4)}{" "}
                    · Scenario peak{" "}
                    {preview.protection.highWatermark.toFixed(4)}
                  </p>
                )}
                <p>
                  Planning checks:{" "}
                  {preview.risk.approved
                    ? "PASS"
                    : preview.risk.reasons.length
                      ? preview.risk.reasons.join(" · ").replaceAll("_", " ")
                      : "WAIT FOR SIGNAL"}
                </p>
                <small>{preview.notice}</small>
              </div>
            )}
          </section>
        </>
      )}
      <section className="panel note">
        <h3>Execution remains disabled.</h3>
        <p className="muted">
          Portfolio accounting, sizing and software protection are development
          controls. Exchange-native protection, fee accounting, complete
          reconciliation and live acceptance remain required before trading. The
          planner does not simulate fills or predict returns.
        </p>
      </section>
    </>
  );
}
