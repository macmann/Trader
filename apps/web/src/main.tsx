import { AdminSettings } from "./AdminSettings.tsx";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { TradingDesk } from "./TradingDesk.tsx";
import { Platform } from "./Platform.tsx";
import { Intelligence } from "./Intelligence.tsx";
type Bot = {
  id: string;
  name: string;
  status: string;
  environment: string;
  symbol: string;
  strategy_version: string;
  advanced_config: any;
  ai_mode?: string;
  config: {
    capital: number;
    maxTrade: number;
    stopLossPct: number;
    takeProfitPct: number;
  };
  quantity: string;
  cost: string;
  realized_pnl: string;
  fees: string;
};
type Connection = {
  id: string;
  name: string;
  provider?: string;
  environment: string;
  status: string;
};
let csrf = "";
async function api(path: string, method = "GET", data?: unknown) {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: data ? JSON.stringify(data) : undefined,
  });
  const value = await r.json();
  if (!r.ok) {
    if (
      path === "/auth/reauthenticate" &&
      value.error === "INVALID_CREDENTIALS"
    )
      throw Error(
        "Your platform password was not accepted. Exchange credentials were not checked.",
      );
    const guidance: Record<string, string> = {
      API_KEY_OR_ENVIRONMENT_MISMATCH:
        "The key does not match the selected endpoint. Global Testnet (.com), EU Testnet (.eu), Demo and Live use separate credentials. Select the same site where you created the key.",
      INVALID_SIGNATURE:
        "Signature rejected. Check the matching API key and secret; create a new pair if necessary.",
      EXCHANGE_CLOCK_SKEW:
        "The server clock is outside Bybit's authentication window. Synchronize the Coolify host clock.",
      IP_BINDING_ERROR:
        "Allow your Coolify server's outbound IP in the API key settings.",
      READ_ONLY_API_KEY_REQUIRED:
        "Use a read-only API key for Bybit EU. Live trading is disabled.",
      PERMISSION_ERROR:
        "Check API permissions. Never enable withdrawals or transfers.",
      API_KEY_EXPIRED:
        "The API key has expired. Replace it in the exchange account.",
    };
    if (guidance[value.error])
      throw Error(
        guidance[value.error] +
          (value.exchangeCode ? ` (Exchange code ${value.exchangeCode})` : ""),
      );
    const detail =
      value.details
        ?.map((v: any) => `${v.path?.join(".")}: ${v.message}`)
        .join("; ") ?? value.reasons?.join("; ");
    throw Error(
      (value.error ?? "Request failed") + (detail ? ": " + detail : ""),
    );
  }
  return value;
}
const money = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    v,
  );
function App() {
  const [user, setUser] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [authMode, setAuthMode] = useState("login"),
    [setupStatus, setSetupStatus] = useState({
      needsSetup: false,
      registrationEnabled: false,
    }),
    [bots, setBots] = useState<Bot[]>([]),
    [connections, setConnections] = useState<Connection[]>([]),
    [records, setRecords] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [dialog, setDialog] = useState(""),
    [connectionProvider, setConnectionProvider] = useState("BYBIT");
  async function refresh() {
    const me = await api("/auth/me");
    csrf = me.csrf;
    setUser(me);
    if (me.verified) {
      const [b, c] = await Promise.all([api("/bots"), api("/connections")]);
      setBots(b);
      setConnections(c);
    }
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void (async () => {
      try {
        const installation = await api("/setup/status");
        setSetupStatus(installation);
        if (installation.needsSetup) setAuthMode("setup");
        const params = new URLSearchParams(location.search);
        if (params.has("verify")) {
          await api("/auth/verify", "POST", { token: params.get("verify") });
          history.replaceState({}, "", location.pathname);
          setNotice("Email verified. You can sign in now.");
        }
        if (params.has("reset")) setAuthMode("reset");
        await refresh();
      } catch {
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (!user?.verified) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [user?.email]);
  useEffect(() => {
    const paths: Record<string, string> = {
      Orders: "/orders",
      Signals: "/signals",
      Activity: "/audit_logs",
      Security: "/auth/login-history",
    };
    if (user?.verified && paths[page])
      void api(paths[page])
        .then(setRecords)
        .catch((e) => setError(e.message));
  }, [page, user?.email]);
  const submit =
    (fn: (data: FormData) => Promise<void>) =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      void run(() => fn(data));
    };
  const feedback = (
    <>
      {error && (
        <div role="alert" className="message error">
          {error.replaceAll("_", " ")}
        </div>
      )}
      {notice && (
        <div role="status" className="message">
          {notice}
        </div>
      )}
    </>
  );
  if (loading)
    return (
      <main className="auth">
        <h1>Opening your workspace…</h1>
      </main>
    );
  if (!user)
    return (
      <main className="auth">
        <div className="brand">
          ◈ TRADER<span>TESTNET</span>
        </div>
        <div className="auth-card">
          <div className="eyebrow">YOUR STRATEGY. YOUR CONTROL.</div>
          <h1>
            {authMode === "setup"
              ? "Set up your installation"
              : authMode === "register"
                ? "Create your workspace"
                : authMode === "reset"
                  ? "Choose a new password"
                  : authMode === "forgot"
                    ? "Reset your password"
                    : "Welcome back."}
          </h1>
          <p className="muted">Build and test a repeatable trading strategy.</p>
          {feedback}
          <form
            onSubmit={submit(async (f) => {
              if (authMode === "setup") {
                const r = await api("/setup", "POST", {
                  token: f.get("token"),
                  email: f.get("email"),
                  password: f.get("password"),
                });
                setSetupStatus({
                  needsSetup: false,
                  registrationEnabled: false,
                });
                setAuthMode("login");
                setNotice(r.message);
                return;
              }
              if (authMode === "forgot") {
                const r = await api("/auth/reset-request", "POST", {
                  email: f.get("email"),
                });
                setNotice(r.message);
                return;
              }
              if (authMode === "reset") {
                await api("/auth/reset", "POST", {
                  token: new URLSearchParams(location.search).get("reset"),
                  password: f.get("password"),
                });
                history.replaceState({}, "", location.pathname);
                setAuthMode("login");
                setNotice("Password reset. Sign in to continue.");
                return;
              }
              const r = await api("/auth/" + authMode, "POST", {
                email: f.get("email"),
                password: f.get("password"),
              });
              if (authMode === "register") {
                setNotice(r.message);
                setAuthMode("login");
              } else {
                csrf = r.csrf;
                await refresh();
              }
            })}
          >
            {authMode === "setup" && (
              <label>
                Installation setup token
                <input
                  type="password"
                  name="token"
                  required
                  minLength={64}
                  maxLength={64}
                  autoComplete="off"
                />
                <small>
                  Use the setup token supplied by your server administrator.
                </small>
              </label>
            )}
            {authMode !== "reset" && (
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                />
              </label>
            )}
            {authMode !== "forgot" && (
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete={
                    authMode === "login" ? "current-password" : "new-password"
                  }
                />
                <small>At least 12 characters</small>
              </label>
            )}
            <button disabled={busy} className="primary">
              {busy
                ? "Please wait…"
                : authMode === "login"
                  ? "Sign in →"
                  : authMode === "register"
                    ? "Create account →"
                    : "Continue →"}
            </button>
          </form>
          {!setupStatus.needsSetup && (
            <div className="auth-links">
              {setupStatus.registrationEnabled && (
                <>
                  <button
                    onClick={() =>
                      setAuthMode(
                        authMode === "register" ? "login" : "register",
                      )
                    }
                  >
                    {authMode === "register"
                      ? "Already have an account? Sign in"
                      : "Create an account"}
                  </button>
                  <button onClick={() => setAuthMode("forgot")}>
                    Forgot password?
                  </button>
                </>
              )}
              {!setupStatus.registrationEnabled && (
                <p>
                  Email delivery has not been configured. Public registration
                  and email recovery are unavailable.
                </p>
              )}
            </div>
          )}
        </div>
        <p className="muted">
          Funds stay at your exchange. Trading can lose money.
        </p>
      </main>
    );
  const active = bots.filter((b) => b.status === "RUNNING").length,
    allocation = bots.reduce((n, b) => n + b.config.capital, 0),
    pnl = bots.reduce(
      (n, b) => n + Number(b.realized_pnl ?? 0) - Number(b.fees ?? 0),
      0,
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">◈ TRADER</div>
        <div className="workspace">
          {user.role} workspace<small>{user.email}</small>
        </div>
        <div className="eyebrow">WORKSPACE</div>
        <nav>
          {[
            "Overview",
            "Bots",
            "Exchanges",
            "Portfolio",
            "Platform",
            "AI Analysis",
            "News",
            "Orders",
            "Signals",
            "Activity",
            "Security",
            ...(user.platformAdmin ? ["Admin Settings"] : []),
          ].map((p, i) => (
            <button
              className={page === p ? "selected" : ""}
              key={p}
              onClick={() => setPage(p)}
            >
              <span>
                {["◫", "◇", "⇄", "◉", "✧", "▤", "≡", "⌁", "◷", "⊙"][i]}
              </span>
              {p}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="dot" /> Testnet environment
          <p>Live execution is disabled.</p>
          <button
            onClick={() =>
              void run(async () => {
                await api("/auth/logout", "POST");
                setUser(null);
              })
            }
          >
            Sign out ↗
          </button>
        </div>
      </aside>
      <section className="main">
        <header>
          <div>
            Workspace <span className="muted">/ {page}</span>
          </div>
          <span className="badge">TESTNET ONLY</span>
        </header>
        <main>
          <div className="heading">
            <div>
              <div className="eyebrow">TRADING WORKSPACE</div>
              <h1>
                {page === "Overview" ? "Your trading, at a glance." : page}
              </h1>
              <p className="muted">
                {page === "Overview"
                  ? "Monitor your bots. Understand every decision."
                  : "Manage your Testnet trading workspace."}
              </p>
            </div>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api("/stop-all", "POST");
                  await refresh();
                  setNotice(
                    "All bots stopped. Existing exchange positions remain open.",
                  );
                })
              }
            >
              ■ Stop all bots
            </button>
          </div>
          {feedback}
          {!user.verified ? (
            <section className="panel">
              <h2>Verify your email to continue</h2>
              <p>Open the verification link in your email, then sign in.</p>
              <button
                onClick={() =>
                  void run(async () => {
                    await api("/auth/resend-verification", "POST");
                    setNotice("Verification email sent.");
                  })
                }
              >
                Resend verification
              </button>
              <button onClick={() => void run(refresh)}>
                I’ve verified my email
              </button>
            </section>
          ) : (
            <>
              {(page === "Overview" || page === "Bots") && (
                <>
                  <div className="metrics">
                    {[
                      [
                        "Bot allocation",
                        money(allocation),
                        "Accounting limits · no funds transferred",
                      ],
                      [
                        "Realized net P&L",
                        money(pnl),
                        "Includes recorded execution fees",
                      ],
                      [
                        "Active bots",
                        String(active),
                        `${bots.length} bots in your workspace`,
                      ],
                      [
                        "Exchange connections",
                        String(
                          connections.filter(
                            (c) =>
                              c.status === "CONNECTED" &&
                              c.environment === "TESTNET",
                          ).length,
                        ),
                        "Independent, encrypted credentials",
                      ],
                    ].map(([label, value, note]) => (
                      <div className="metric" key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                        <small>{note}</small>
                      </div>
                    ))}
                  </div>
                  <div className="section-heading">
                    <h2>
                      Your bots <span className="count">{bots.length}</span>
                    </h2>
                    <button
                      className="primary"
                      onClick={() => setDialog("bot")}
                    >
                      + Create bot
                    </button>
                  </div>
                  {!bots.length ? (
                    <section className="empty panel">
                      <div className="empty-icon">◇</div>
                      <h2>Your first strategy starts here.</h2>
                      <p>
                        Connect a Bybit Testnet account, then create a BTCUSDT
                        bot.
                        <br />
                        Start with $100 allocation and a $20 trade limit.
                      </p>
                      <button
                        className="primary"
                        onClick={() =>
                          connections.length
                            ? setDialog("bot")
                            : setPage("Exchanges")
                        }
                      >
                        {connections.length
                          ? "Create your first bot"
                          : "Connect an exchange →"}
                      </button>
                    </section>
                  ) : (
                    <div className="bot-grid">
                      {bots.map((b) => (
                        <article className="panel bot-card" key={b.id}>
                          <div className="row">
                            <span className="coin">₿</span>
                            <span className="badge">{b.environment}</span>
                          </div>
                          <h2>{b.name}</h2>
                          <p className="muted">
                            {b.symbol} · Spot · 15m · {b.strategy_version}
                          </p>
                          <span
                            className={
                              "status " +
                              (b.status === "RUNNING" ? "running" : "")
                            }
                          >
                            {b.status.replaceAll("_", " ")}
                          </span>
                          <div className="bot-stats">
                            <div>
                              <small>Allocation</small>
                              <strong>{money(b.config.capital)}</strong>
                            </div>
                            <div>
                              <small>Realized net P&L</small>
                              <strong>
                                {money(
                                  Number(b.realized_pnl ?? 0) -
                                    Number(b.fees ?? 0),
                                )}
                              </strong>
                            </div>
                            <div>
                              <small>
                                {b.symbol.replace(/USDT$/, " ")}position
                              </small>
                              <strong>
                                {Number(b.quantity ?? 0).toFixed(6)}
                              </strong>
                            </div>
                            <div>
                              <small>Max trade</small>
                              <strong>{money(b.config.maxTrade)}</strong>
                            </div>
                          </div>
                          <p className="muted">
                            SL {b.config.stopLossPct}% · TP{" "}
                            {b.config.takeProfitPct}% · AI {b.ai_mode ?? "OFF"}
                          </p>
                          <div className="actions">
                            {["start", "pause", "stop"].map((action) => (
                              <button
                                key={action}
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await api(
                                      `/bots/${b.id}/${action}`,
                                      "POST",
                                    );
                                    await refresh();
                                  })
                                }
                              >
                                {action}
                              </button>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  <section className="panel note">
                    <h3>Every trade has a reason.</h3>
                    <p>
                      Market data → Trend strategy → Risk checks → Execution.
                      Review Signals to see approvals and rejections. Configure
                      Advisory or Filter in AI Analysis.
                    </p>
                    <small>
                      Stop and pause prevent new execution. They request
                      cancellation of resting entries and do not liquidate
                      existing positions. Software stop-loss checks require the
                      worker and exchange connection to remain available.
                    </small>
                  </section>
                </>
              )}
              {page === "Admin Settings" && user.platformAdmin && (
                <AdminSettings request={api} />
              )}
              {page === "Platform" && (
                <Platform
                  key={user.tenantId}
                  request={api}
                  user={user}
                  refresh={refresh}
                  connections={connections}
                  bots={bots}
                />
              )}
              {page === "Portfolio" && (
                <TradingDesk bots={bots} request={api} refreshBots={refresh} />
              )}
              {["AI Analysis", "News"].includes(page) && (
                <Intelligence
                  page={page}
                  bots={bots}
                  request={api}
                  refreshBots={refresh}
                />
              )}
              {page === "Exchanges" && (
                <>
                  <div className="section-heading">
                    <h2>Connected exchanges</h2>
                    <button
                      className="primary"
                      onClick={() => setDialog("connection")}
                    >
                      + Connect exchange
                    </button>
                  </div>
                  {!connections.length ? (
                    <section className="empty panel">
                      <h2>Your funds stay with you.</h2>
                      <p>
                        Connect a dedicated Bybit Testnet account with read and
                        Spot trading permissions.
                        <br />
                        Withdrawal and transfer permissions are refused.
                      </p>
                      <button
                        className="primary"
                        onClick={() => setDialog("connection")}
                      >
                        Connect exchange Testnet
                      </button>
                    </section>
                  ) : (
                    connections.map((c) => (
                      <section className="panel connection" key={c.id}>
                        <div>
                          <h2>{c.name}</h2>
                          <span className="badge">
                            {c.environment === "LIVE"
                              ? "LIVE — READ-ONLY"
                              : c.environment}
                          </span>{" "}
                          <span>{c.status}</span>
                        </div>
                        <button
                          className="danger"
                          onClick={() =>
                            void run(async () => {
                              await api("/connections/" + c.id, "DELETE");
                              await refresh();
                            })
                          }
                        >
                          Disconnect
                        </button>
                      </section>
                    ))
                  )}
                </>
              )}
              {["Orders", "Signals", "Activity", "Security"].includes(page) && (
                <section className="panel">
                  <h2>
                    {page === "Security"
                      ? "Login history"
                      : `Recent ${page.toLowerCase()}`}
                  </h2>
                  {records.length ? (
                    <div className="record-list">
                      {records.map((r, i) => (
                        <div className="record" key={r.id ?? i}>
                          <div>
                            <strong>
                              {r.action ??
                                r.side ??
                                r.data?.direction ??
                                (r.succeeded
                                  ? "Successful login"
                                  : "Failed login")}
                            </strong>
                            <small>
                              {new Date(r.created_at).toLocaleString()}
                            </small>
                          </div>
                          <pre>
                            {JSON.stringify(
                              r.decision ??
                                (r.state
                                  ? { status: r.state, quantity: r.quantity }
                                  : (r.data ?? {})),
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty">
                      <p>No records yet.</p>
                    </div>
                  )}
                  {page === "Security" && (
                    <>
                      <h3>Confirm a sensitive action</h3>
                      <form
                        onSubmit={submit(async (f) => {
                          await api("/auth/reauthenticate", "POST", {
                            password: f.get("password"),
                          });
                          setNotice("Identity confirmed for five minutes.");
                        })}
                      >
                        <label>
                          Password
                          <input
                            name="password"
                            type="password"
                            required
                            autoComplete="current-password"
                          />
                        </label>
                        <button disabled={busy}>Confirm identity</button>
                      </form>
                      <button
                        onClick={() =>
                          void run(async () => {
                            await api("/auth/revoke-other-sessions", "POST");
                            setNotice("Other sessions revoked.");
                          })
                        }
                      >
                        Sign out other sessions
                      </button>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </main>
        <footer>Testnet workspace · No custody · No guaranteed returns</footer>
      </section>
      {dialog && (
        <div className="overlay">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialog === "bot" ? "Create bot" : "Connect exchange"}
          >
            <button className="close" onClick={() => setDialog("")}>
              ✕
            </button>
            <div className="eyebrow">
              {dialog === "connection" && connectionProvider === "BYBIT_EU"
                ? "LIVE ACCOUNT — READ-ONLY"
                : "TESTNET WORKSPACE"}
            </div>
            <h2>{dialog === "bot" ? "Create your bot" : "Connect exchange"}</h2>
            {feedback}
            {dialog === "connection" ? (
              <form
                onSubmit={submit(async (f) => {
                  await api("/auth/reauthenticate", "POST", {
                    password: f.get("password"),
                  });
                  await api("/connections", "POST", {
                    name: f.get("name"),
                    environment:
                      f.get("provider") === "BYBIT_EU" ? "LIVE" : "TESTNET",
                    readOnlyAcknowledged:
                      f.get("readOnlyAcknowledged") === "on",
                    apiKey: f.get("apiKey"),
                    apiSecret: f.get("apiSecret"),
                    provider: f.get("provider"),
                    ...(f.get("passphrase")
                      ? { passphrase: f.get("passphrase") }
                      : {}),
                  });
                  setDialog("");
                  await refresh();
                })}
              >
                <label>
                  Connection name
                  <input
                    name="name"
                    key={connectionProvider}
                    defaultValue={
                      connectionProvider === "BYBIT_EU"
                        ? "My Bybit EU (read-only)"
                        : "My Testnet account"
                    }
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  Provider
                  <select
                    name="provider"
                    value={connectionProvider}
                    onChange={(e) => setConnectionProvider(e.target.value)}
                  >
                    <option value="BYBIT">Bybit Global Testnet (.com)</option>
                    <option value="BYBIT_EU_TESTNET">
                      Bybit EU Testnet (.eu)
                    </option>
                    <option value="OKX">OKX Demo</option>
                    <option value="BYBIT_EU">
                      Bybit EU — LIVE, read-only preview (broker access
                      required)
                    </option>
                  </select>
                </label>
                <label>
                  OKX passphrase (OKX only)
                  <input name="passphrase" type="password" autoComplete="off" />
                </label>
                <label>
                  API key
                  <input
                    name="apiKey"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </label>
                <label>
                  API secret
                  <input
                    name="apiSecret"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </label>
                {connectionProvider === "BYBIT_EU" && (
                  <div role="note">
                    <strong>LIVE ACCOUNT — READ-ONLY CONNECTION</strong>
                    <p>
                      Bybit EU requires broker-authorized third-party API
                      access. Testnet keys are separate from mainnet. Use a
                      read-only key; this connection cannot run bots or
                      submit/cancel orders. Testnet keys do not work here.
                    </p>
                    <label>
                      <input
                        type="checkbox"
                        name="readOnlyAcknowledged"
                        required
                      />
                      I understand this connects a live EU account for read-only
                      verification.
                    </label>
                  </div>
                )}
                <label>
                  Confirm your platform password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <p className="muted">
                  Credentials are verified with the selected exchange before
                  encrypted storage.{" "}
                  {connectionProvider === "BYBIT_EU"
                    ? "Use a read-only EU key."
                    : "Enable Spot trading for Testnet."}{" "}
                  Withdrawals and transfers must be disabled.
                </p>
                <button className="primary" disabled={busy}>
                  {busy ? "Verifying…" : "Test connection & save"}
                </button>
              </form>
            ) : (
              <form
                onSubmit={submit(async (f) => {
                  await api("/bots", "POST", {
                    name: f.get("name"),
                    connectionId: f.get("connectionId"),
                    symbol: f.get("symbol"),
                    strategyVersion: f.get("strategyVersion"),
                    config: Object.fromEntries(
                      [
                        "capital",
                        "maxTrade",
                        "stopLossPct",
                        "takeProfitPct",
                        "dailyLoss",
                      ].map((k) => [k, Number(f.get(k))]),
                    ),
                  });
                  setDialog("");
                  await refresh();
                })}
              >
                <label>
                  Bot name
                  <input
                    name="name"
                    defaultValue="BTC Trend Bot"
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  Exchange
                  <select name="connectionId" required>
                    <option value="">Select a connected Testnet account</option>
                    {connections
                      .filter(
                        (c) =>
                          c.status === "CONNECTED" &&
                          c.environment === "TESTNET",
                      )
                      .map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="form-grid">
                  <label>
                    Spot pair
                    <select name="symbol">
                      <option>BTCUSDT</option>
                      <option>ETHUSDT</option>
                      <option>SOLUSDT</option>
                    </select>
                  </label>
                  <label>
                    Strategy
                    <select name="strategyVersion">
                      <option value="trend-v1.0">Trend v1.0</option>
                      <option value="breakout-v1.0">Breakout v1.0</option>
                      <option value="dca-v1.0">Bounded DCA v1.0</option>
                    </select>
                  </label>
                </div>
                <div className="form-grid">
                  {[
                    ["capital", "Capital allocation ($)", 100],
                    ["maxTrade", "Maximum trade ($)", 20],
                    ["stopLossPct", "Stop loss (%)", 2],
                    ["takeProfitPct", "Take profit (%)", 4],
                    ["dailyLoss", "Daily loss limit ($)", 5],
                  ].map(([name, label, value]) => (
                    <label key={name}>
                      {label}
                      <input
                        type="number"
                        name={String(name)}
                        defaultValue={value}
                        min="0.01"
                        step="0.01"
                        required
                      />
                    </label>
                  ))}
                </div>
                <p className="muted">
                  Selected pair · Spot · 15 minutes · Versioned strategy · AI
                  off
                  <br />
                  10 trades/day · 10% drawdown limit · One open position
                </p>
                <button className="primary" disabled={busy}>
                  Create stopped bot
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
