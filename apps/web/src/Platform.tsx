import React, { useEffect, useState } from "react";
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
const fmt = (v: any) => (typeof v === "number" ? v.toFixed(2) : "—");
export function Platform({
  request,
  user,
  refresh,
  connections,
  bots,
}: {
  request: Request;
  user: any;
  refresh: () => Promise<void>;
  connections: any[];
  bots: any[];
}) {
  const [tab, setTab] = useState("Research"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [workspaces, setWorkspaces] = useState<any[]>([]),
    [members, setMembers] = useState<any[]>([]),
    [runs, setRuns] = useState<any[]>([]),
    [paper, setPaper] = useState<any[]>([]),
    [listings, setListings] = useState<any[]>([]),
    [notifications, setNotifications] = useState<any[]>([]),
    [plan, setPlan] = useState<any>(null),
    [settings, setSettings] = useState<any>({}),
    [options, setOptions] = useState<any>({ strategies: [] }),
    [dataset, setDataset] = useState(""),
    [result, setResult] = useState<any>(null);
  const writable = user.role !== "VIEWER",
    admin = ["OWNER", "ADMIN"].includes(user.role);
  async function load() {
    const [w, m, r, p, l, n, s, t, o] = await Promise.all(
      [
        "/workspaces",
        "/workspace/members",
        "/research",
        "/paper",
        "/marketplace",
        "/notifications",
        "/subscription",
        "/notifications/settings",
        "/trading/options",
      ].map((p) => request(p)),
    );
    setWorkspaces(w);
    setMembers(m);
    setRuns(r);
    setPaper(p);
    setListings(l);
    setNotifications(n);
    setPlan(s);
    setSettings(t);
    setOptions(o);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [user.tenantId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form =
    (fn: (f: FormData) => Promise<void>) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void action(() => fn(f));
    };
  function configuration(f: FormData) {
    return {
      symbol: f.get("symbol"),
      strategyVersion: f.get("strategy"),
      config: {
        capital: Number(f.get("capital")),
        maxTrade: Number(f.get("maxTrade")),
        stopLossPct: Number(f.get("stopLoss")),
        takeProfitPct: Number(f.get("takeProfit")),
      },
      advancedConfig: {
        dcaStepPct: Number(f.get("dcaStep")),
        gridLower: f.get("gridLower") ? Number(f.get("gridLower")) : null,
        gridUpper: f.get("gridUpper") ? Number(f.get("gridUpper")) : null,
      },
      settings: {
        feeBps: Number(f.get("fee")),
        slippageBps: Number(f.get("slippage")),
      },
    };
  }
  const configFields = (
    <div className="config-grid">
      <label>
        Pair
        <select name="symbol">
          {["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Strategy
        <select name="strategy" defaultValue="dca-v1.0">
          {options.strategies.map((s: any) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
      </label>
      {[
        ["capital", "Capital ($)", 100],
        ["maxTrade", "Maximum trade ($)", 20],
        ["stopLoss", "Stop loss (%)", 2],
        ["takeProfit", "Take profit (%)", 4],
        ["dcaStep", "DCA step (%)", 2],
        ["gridLower", "Grid lower price", ""],
        ["gridUpper", "Grid upper price", ""],
        ["fee", "Fee (basis points)", 10],
        ["slippage", "Slippage (basis points)", 5],
      ].map(([name, label, value]) => (
        <label key={name}>
          {label}
          <input
            name={String(name)}
            type="number"
            step="any"
            defaultValue={value}
            required={!String(name).startsWith("grid")}
          />
        </label>
      ))}
    </div>
  );
  function metrics(r: any) {
    if (!r) return null;
    if (r.folds)
      return (
        <div>
          <p>
            {r.folds.length} independent out-of-sample windows · mean return{" "}
            {fmt(r.meanOutOfSampleReturnPct)}%
          </p>
          {r.folds.map((f: any) => (
            <p key={f.testStart}>
              {new Date(f.testStart).toLocaleDateString()} · OOS return{" "}
              {fmt(f.outOfSample.returnPct)}% · drawdown{" "}
              {fmt(f.outOfSample.maxDrawdownPct)}%
            </p>
          ))}
        </div>
      );
    const values = r.equity ?? [],
      min = Math.min(...values.map((x: any) => x.value), r.startingEquity),
      max = Math.max(...values.map((x: any) => x.value), r.startingEquity);
    return (
      <>
        <div className="comparison-grid">
          {[
            ["Equity", r.endingEquity],
            ["Return (%)", r.returnPct],
            ["Drawdown (%)", r.maxDrawdownPct],
            ["Fees", r.fees],
            ["Closed trades", r.closedTrades],
            ["Win rate (%)", r.winRate],
          ].map(([label, v]) => (
            <div className="metric" key={label}>
              <span>{label}</span>
              <strong>{fmt(v)}</strong>
            </div>
          ))}
        </div>
        {values.length > 1 && (
          <svg
            viewBox="0 0 600 130"
            role="img"
            aria-label="Simulated equity over supplied candles"
            className="equity-chart"
          >
            <polyline
              fill="none"
              stroke="#65dcb6"
              strokeWidth="2"
              points={values
                .map(
                  (x: any, i: number) =>
                    `${(i / (values.length - 1)) * 600},${120 - ((x.value - min) / (max - min || 1)) * 110}`,
                )
                .join(" ")}
            />
          </svg>
        )}
      </>
    );
  }
  return (
    <div className="platform">
      <nav className="platform-tabs">
        {[
          "Research",
          "Paper trading",
          "Marketplace",
          "Workspace",
          "Subscription",
          "Notifications",
        ].map((t) => (
          <button
            key={t}
            className={tab === t ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="message error">
          {error.replaceAll("_", " ")}
        </p>
      )}
      {notice && (
        <p role="status" className="message">
          {notice}
        </p>
      )}
      {["Research", "Paper trading"].includes(tab) && (
        <section className="panel">
          <h2>
            {tab === "Research"
              ? "Historical research"
              : "Independent paper trading"}
          </h2>
          <p className="muted">
            Simulation only. No exchange credentials, orders or funds. Results
            depend on supplied 15-minute OHLCV data, fees and fill assumptions;
            historical results do not guarantee future returns.
          </p>
          <label>
            Upload a JSON array of candles
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > 1200000) {
                    setError("Dataset exceeds 1.2 MB");
                    return;
                  }
                  void file.text().then(setDataset);
                }
              }}
            />
          </label>
          <label>
            Candles JSON
            <textarea
              rows={5}
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              placeholder='[{"time":0,"open":100,"high":101,"low":99,"close":100,"volume":100}]'
            />
          </label>
          <small>
            Unique, ascending candles exactly 900,000 ms apart; up to 5,000
            bars. Paper advances accept only the next bars.
          </small>
          <form
            onSubmit={form(async (f) => {
              const configurationValue = configuration(f);
              if (tab === "Paper trading") {
                await request("/paper", "POST", {
                  name: f.get("name"),
                  feedMode: f.get("feedMode"),
                  configuration: configurationValue,
                });
                setNotice(
                  f.get("feedMode") === "MARKET"
                    ? "Paper session created. The worker will advance it from public market candles."
                    : "Paper session created. Advance it with the next supplied candles.",
                );
              } else {
                const base = configurationValue.advancedConfig;
                const data = await request("/research", "POST", {
                  configuration: configurationValue,
                  candles: JSON.parse(dataset),
                  ...(f.get("walk")
                    ? {
                        walkForward: {
                          trainBars: Number(f.get("train")),
                          testBars: Number(f.get("test")),
                          candidates: [
                            base,
                            {
                              ...base,
                              dcaStepPct: Math.min(50, base.dcaStepPct * 1.5),
                            },
                          ],
                        },
                      }
                    : {}),
                });
                setResult(data.result);
              }
            })}
          >
            {tab === "Paper trading" && (
              <label>
                Session name
                <input name="name" required maxLength={80} />
              </label>
            )}
            {tab === "Paper trading" && (
              <label>
                Data feed
                <select name="feedMode">
                  <option value="REPLAY">Uploaded candle replay</option>
                  <option value="MARKET">Automatic public market feed</option>
                </select>
              </label>
            )}
            {configFields}
            {tab === "Research" && (
              <>
                <label>
                  <input name="walk" type="checkbox" /> Walk-forward: select
                  between configured DCA step and 1.5× step using training data
                  only
                </label>
                <div className="config-grid">
                  <label>
                    Training bars
                    <input
                      name="train"
                      type="number"
                      min="60"
                      defaultValue="120"
                    />
                  </label>
                  <label>
                    Test bars
                    <input
                      name="test"
                      type="number"
                      min="15"
                      defaultValue="60"
                    />
                  </label>
                </div>
              </>
            )}
            <button className="primary" disabled={busy || !writable}>
              {tab === "Research" ? "Run research" : "Create paper session"}
            </button>
          </form>
          {metrics(result)}
        </section>
      )}
      {tab === "Research" && (
        <>
          <section className="panel">
            <h2>Saved research</h2>
            {runs.map((r) => (
              <div className="platform-row" key={r.id}>
                <span>
                  {r.symbol} · {r.strategy_version} · {r.kind}
                </span>
                <button onClick={() => setResult(r.result)}>
                  View results
                </button>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Publish an immutable strategy version</h2>
            <p>
              Publishing attaches server-stored backtest results to the exact
              configuration. DCA/grid are classified very high risk; other
              strategies are high risk. No user-supplied live performance is
              accepted.
            </p>
            <form
              onSubmit={form(async (f) => {
                await request("/marketplace/listings", "POST", {
                  name: f.get("name"),
                  description: f.get("description"),
                  researchRunId: f.get("run"),
                  ...(f.get("listing") ? { listingId: f.get("listing") } : {}),
                });
                setNotice(
                  "Version published. Existing subscribers stay pinned to their chosen version.",
                );
              })}
            >
              <label>
                Name
                <input name="name" required maxLength={80} />
              </label>
              <label>
                Description
                <textarea name="description" required maxLength={1500} />
              </label>
              <label>
                Backtest
                <select name="run" required>
                  {runs
                    .filter((r) => r.kind === "BACKTEST")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.symbol} · {r.strategy_version} ·{" "}
                        {new Date(r.created_at).toLocaleString()}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Optional listing ID for a new version
                <input
                  name="listing"
                  placeholder="Leave blank for a new listing"
                />
              </label>
              <button
                disabled={
                  busy || !admin || !runs.some((r) => r.kind === "BACKTEST")
                }
              >
                Publish version
              </button>
            </form>
          </section>
        </>
      )}
      {tab === "Paper trading" &&
        paper.map((p) => (
          <section className="panel" key={p.id}>
            <h2>
              {p.name} <span className="badge">PAPER · {p.status}</span>
            </h2>
            <p>
              {p.symbol} · {p.strategy_version} · {p.feed_mode} · revision{" "}
              {p.revision}
            </p>
            {metrics(p.result)}
            <div className="actions">
              <button
                disabled={
                  busy ||
                  !writable ||
                  p.status !== "RUNNING" ||
                  p.feed_mode !== "REPLAY"
                }
                onClick={() =>
                  void action(async () => {
                    const v = await request(`/paper/${p.id}/advance`, "POST", {
                      revision: p.revision,
                      candles: JSON.parse(dataset),
                    });
                    setResult(v.result);
                  })
                }
              >
                Advance with uploaded candles
              </button>
              <button
                disabled={busy || !writable || p.status !== "RUNNING"}
                onClick={() =>
                  void action(async () => {
                    await request(`/paper/${p.id}/stop`, "POST", {});
                  })
                }
              >
                Stop
              </button>
              <button
                disabled={busy || !writable}
                onClick={() =>
                  void action(async () => {
                    await request(`/paper/${p.id}`, "DELETE");
                  })
                }
              >
                Delete experiment
              </button>
            </div>
          </section>
        ))}
      {tab === "Marketplace" && (
        <>
          <p className="message">
            Historical performance is simulated; exchange evidence is separately
            labelled. Verified live results are unavailable while live trading
            is disabled. Subscribing does not start a bot, transfer funds or
            create a payment.
          </p>
          {listings.map((l) => (
            <section className="panel" key={l.version_id}>
              <h2>
                {l.name} <span className="badge">v{l.version}</span>
              </h2>
              <p>{l.description}</p>
              <p>
                {l.symbol} · {l.strategy_version} ·{" "}
                {l.risk_classification.replaceAll("_", " ")} RISK
              </p>
              <p>
                Historical return {fmt(l.historical_results.returnPct)}% ·
                drawdown {fmt(l.historical_results.maxDrawdownPct)}% · fees{" "}
                {fmt(l.historical_results.fees)} ·{" "}
                {l.historical_results.closedTrades} closed trades
              </p>
              <small>
                Listing ID: {l.id} · dataset{" "}
                {l.historical_results.datasetHash.slice(0, 12)} · verified live:
                unavailable
              </small>
              {l.verified_testnet_results && (
                <p>
                  Exchange-reconciled Testnet:{" "}
                  {l.verified_testnet_results.closedTrades} closed trades · net
                  return {fmt(l.verified_testnet_results.netReturnPct)}% ·
                  closed-trade drawdown{" "}
                  {fmt(l.verified_testnet_results.closedTradeDrawdownPct)}%
                </p>
              )}
              {l.verified_live_results && (
                <p>
                  Exchange-reconciled Live:{" "}
                  {l.verified_live_results.closedTrades} closed trades · net
                  return {fmt(l.verified_live_results.netReturnPct)}%
                </p>
              )}
              {l.is_owner && admin && (
                <form
                  onSubmit={form(async (f) => {
                    await request(
                      `/marketplace/listings/${l.id}/evidence`,
                      "POST",
                      { botId: f.get("bot") },
                    );
                    setNotice(
                      "Exchange-reconciled closed-trade evidence published.",
                    );
                  })}
                >
                  <label>
                    Publish evidence from a matching version bot
                    <select name="bot" required>
                      {bots
                        .filter(
                          (b) => b.marketplace_version_id === l.version_id,
                        )
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={
                      busy ||
                      !bots.some(
                        (b) => b.marketplace_version_id === l.version_id,
                      )
                    }
                  >
                    Publish reconciled evidence
                  </button>
                </form>
              )}
              <div className="actions">
                <button
                  disabled={busy || !writable}
                  onClick={() =>
                    void action(async () => {
                      await request(
                        l.subscribed
                          ? `/marketplace/subscriptions/${l.version_id}`
                          : `/marketplace/versions/${l.version_id}/subscribe`,
                        l.subscribed ? "DELETE" : "POST",
                        l.subscribed ? undefined : {},
                      );
                    })
                  }
                >
                  {l.subscribed ? "Unsubscribe" : "Subscribe to this version"}
                </button>
              </div>
              {l.subscribed && (
                <form
                  onSubmit={form(async (f) => {
                    await request("/bots", "POST", {
                      name: f.get("name"),
                      connectionId: f.get("connection"),
                      marketplaceVersionId: l.version_id,
                      config: {},
                    });
                    setNotice(
                      "Stopped bot created from the pinned configuration. Review risk before starting.",
                    );
                    await refresh();
                  })}
                >
                  <div className="config-grid">
                    <label>
                      Bot name
                      <input
                        name="name"
                        defaultValue={l.name + " v" + l.version}
                        required
                        maxLength={80}
                      />
                    </label>
                    <label>
                      Exchange
                      <select name="connection" required>
                        {connections
                          .filter((c) => c.status === "CONNECTED")
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <button disabled={busy || !writable || !connections.length}>
                    Create stopped bot from version
                  </button>
                </form>
              )}
              {l.is_owner && (
                <button
                  disabled={busy || !admin}
                  onClick={() =>
                    void action(async () => {
                      await request(
                        `/marketplace/listings/${l.id}/retire`,
                        "POST",
                        {},
                      );
                    })
                  }
                >
                  Retire listing
                </button>
              )}
            </section>
          ))}
        </>
      )}
      {tab === "Workspace" && (
        <>
          <section className="panel">
            <h2>Workspace access</h2>
            <p>
              Current role: {user.role}. Switching workspaces changes all
              tenant-scoped views.
            </p>
            <label>
              Active workspace
              <select
                value={user.tenantId}
                onChange={(e) => {
                  const id = e.target.value;
                  void action(async () => {
                    await request("/auth/workspace", "POST", { tenantId: id });
                    await refresh();
                  });
                }}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {w.role}
                  </option>
                ))}
              </select>
            </label>
            <form
              onSubmit={form(async (f) => {
                await request("/workspaces", "POST", { name: f.get("name") });
                setNotice("Organization created; select it above.");
              })}
            >
              <label>
                New organization name
                <input name="name" required maxLength={80} />
              </label>
              <button disabled={busy || !admin}>Create organization</button>
            </form>
          </section>
          <section className="panel">
            <h2>Members</h2>
            {members.map((m) => (
              <div className="platform-row" key={m.user_id}>
                <span>
                  {m.email} · {m.role}
                </span>
                {m.role !== "OWNER" && admin && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await request(
                          `/workspace/members/${m.user_id}`,
                          "DELETE",
                        );
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <p>
              Add an existing verified account to an organization or change its
              role. Owner access cannot be removed or granted here. Sensitive
              actions require recent password confirmation in Security.
            </p>
            <form
              onSubmit={form(async (f) => {
                await request("/workspace/members", "PUT", {
                  email: f.get("email"),
                  role: f.get("role"),
                });
              })}
            >
              <label>
                Registered email
                <input name="email" type="email" required />
              </label>
              <label>
                Role
                <select name="role">
                  <option>VIEWER</option>
                  <option>TRADER</option>
                  {user.role === "OWNER" && <option>ADMIN</option>}
                </select>
              </label>
              <button disabled={busy || !admin}>Save member role</button>
            </form>
          </section>
        </>
      )}
      {tab === "Subscription" && plan && (
        <section className="panel">
          <h2>{plan.plan} plan</h2>
          <p>
            Entitlements apply to this workspace. Payment collection is not
            enabled. Plan changes require a signed event from the platform
            billing gateway.
          </p>
          <div className="comparison-grid">
            {Object.entries(plan.plans).map(([name, v]: any) => (
              <div className="metric" key={name}>
                <strong>{name}</strong>
                <p>
                  {v.bots} bots · {v.paper} paper sessions
                </p>
                <p>
                  {v.backtests} research runs/month · {v.ai} AI analyses/month
                </p>
              </div>
            ))}
          </div>
          <h3>This month</h3>
          {plan.usage.map((u: any) => (
            <p key={u.metric}>
              {u.metric}: {u.units}
            </p>
          ))}
        </section>
      )}
      {tab === "Notifications" && (
        <>
          <section className="panel">
            <h2>Workspace notifications</h2>
            {notifications.map((n) => (
              <div className="platform-row" key={n.id}>
                <span>
                  {n.title} · {new Date(n.created_at).toLocaleString()} ·
                  Telegram {n.telegram_state}
                </span>
                {!n.read_at && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await request(
                          `/notifications/${n.id}/read`,
                          "POST",
                          {},
                        );
                      })
                    }
                  >
                    Mark read
                  </button>
                )}
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>Telegram delivery</h2>
            <p>
              {settings.telegramConfigured
                ? "Platform bot configured."
                : "Platform Telegram token is not configured."}{" "}
              Messages contain event titles only. Failed or uncertain deliveries
              are not automatically retried.
            </p>
            <form
              onSubmit={form(async (f) => {
                await request("/notifications/settings", "PUT", {
                  enabled: !!f.get("enabled"),
                  chatId: f.get("chat"),
                });
              })}
            >
              <label>
                Chat ID
                <input
                  name="chat"
                  defaultValue={settings.telegram_chat_id ?? ""}
                  required
                  pattern="-?[0-9]{1,20}"
                />
              </label>
              <label>
                <input
                  name="enabled"
                  type="checkbox"
                  defaultChecked={settings.enabled}
                />{" "}
                Enable notifications to this chat
              </label>
              <button disabled={busy || !admin}>Save Telegram settings</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
