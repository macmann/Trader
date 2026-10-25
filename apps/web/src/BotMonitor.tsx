import { MonitorHistory } from "./MonitorHistory.tsx";
import { monitorTime as when } from "./monitor-time.ts";
import { botActionEnabled } from "../../../packages/core/src/bot-actions.ts";
import React, { useEffect, useRef, useState } from "react";
const money = (v: unknown) =>
  v === null || v === undefined
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(Number(v));
const text = (v: unknown) =>
  String(v ?? "Unknown")
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
const descriptions: Record<string, string> = {
  RECONCILIATION_FAILED:
    "An older reconciliation failed without a detailed diagnostic. Review orders and exchange configuration; retry once to capture a new worker diagnostic rather than repeatedly pressing Start.",
  RECONCILIATION_REQUIRED:
    "Exchange orders and fills have not reconciled with the ledger. New execution is locked; review orders and activity before retrying.",
  UNEXPECTED_ACCOUNT_POSITION:
    "Exchange holdings changed beyond the saved non-bot inventory plus tracked bot positions. Review the account changes and recorded fills.",
  INVENTORY_BASELINE_REVIEW_REQUIRED:
    "An existing trading ledger and exchange holdings need verified reconciliation before an inventory baseline can be established.",
  UNEXPECTED_EXCHANGE_EXECUTION:
    "The exchange returned a fill that does not belong to known platform orders. Check manual trades or other automation using this account; do not reset history to conceal the mismatch.",
  UNEXPECTED_EXCHANGE_ORDER:
    "An exchange order is not attributed to this platform. Inspect the exchange account and reconcile it before retrying.",
  LEDGER_REBUILD_REQUIRED:
    "Legacy accounting needs a verified ledger rebuild before execution can resume.",
  RECONCILIATION_WINDOW_EXCEEDED:
    "The history gap exceeds the adapter's reconciliation window. A verified history/ledger recovery is needed; repeated Start cannot repair the missing interval.",
  UNSUPPORTED_FEE_CURRENCY:
    "A fee asset cannot be safely valued by the ledger. Accounting and execution remain locked until the fee can be reconciled.",
  PRIVATE_STREAM_NOT_READY:
    "Waiting for authenticated order/fill subscriptions. No new order can be sent until the private stream is ready.",
  MARKET_DATA_STALE_OR_INVALID:
    "Market data is stale or invalid. New orders are blocked until fresh data arrives.",
  WORKER_CHECK_FAILED:
    "A worker check failed. The underlying exception was redacted; inspect sanitized worker logs for the error type.",
  EXECUTION_DISABLED:
    "Testnet order execution is Off in Admin Settings. Monitoring and reconciliation continue.",
  WORKER_STATUS_STALE_OR_UNKNOWN:
    "No recent completed worker observation. Check the worker container and exchange connectivity; running status alone does not prove the worker is healthy.",
  GLOBAL_EXECUTION_STOP: "The platform emergency stop is active.",
  API_KEY_OR_ENVIRONMENT_MISMATCH:
    "The stored key does not match the selected exchange environment/region.",
  NEXT_CLOSED_CANDLE:
    "The last closed candle has already been evaluated. Waiting for the next candle, while monitoring positions.",
};
const tabs = [
  ["overview", "Overview"],
  ["fills", "Entries / exits"],
  ["orders", "Order history"],
  ["cycles", "Closed trades"],
  ["signals", "Signals & risk"],
  ["ai", "AI decisions"],
  ["activity", "Activity"],
  ["events", "Order events"],
  ["runs", "Start / stop runs"],
  ["configuration", "Configuration"],
];
export function BotMonitor({
  id,
  request,
  onClose,
  onAction,
  pending,
  knownStatus,
}: {
  id: string;
  request: (path: string, method?: string, data?: unknown) => Promise<any>;
  onClose: () => void;
  onAction: (action: string) => Promise<void>;
  pending?: string;
  knownStatus?: string;
}) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("overview"),
    [runId, setRunId] = useState(""),
    [runs, setRuns] = useState<any[]>([]),
    [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [historyError, setHistoryError] = useState(""),
    [loading, setLoading] = useState(false);
  const historyGeneration = useRef(0),
    historyBusy = useRef(false),
    historyRequest = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    let cancelled = false,
      inFlight = false;
    mounted.current = true;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const value = await request(`/bots/${id}/monitor`);
        if (!cancelled) {
          setSnapshot(value);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    document
      .getElementById("bot-monitor")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    void request(`/bots/${id}/history?kind=runs&limit=100`)
      .then((value) => {
        if (!cancelled) setRuns(value.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, snapshot?.activeRun?.id]);
  const filterable = !["activity", "ai", "runs"].includes(tab),
    effectiveRun = filterable ? runId : "";
  async function history(append = false) {
    if (["overview", "configuration"].includes(tab) || historyBusy.current)
      return;
    historyBusy.current = true;
    const generation = historyGeneration.current;
    const ticket = ++historyRequest.current;
    setLoading(true);
    setHistoryError("");
    try {
      const q = new URLSearchParams({ kind: tab, limit: "25" });
      if (effectiveRun) q.set("runId", effectiveRun);
      if (append && cursor) q.set("cursor", cursor);
      const result = await request(`/bots/${id}/history?${q}`);
      if (mounted.current && generation === historyGeneration.current) {
        setItems((old) => (append ? [...old, ...result.items] : result.items));
        setCursor(result.nextCursor);
      }
    } catch (e) {
      if (mounted.current && generation === historyGeneration.current)
        setHistoryError((e as Error).message);
    } finally {
      if (ticket === historyRequest.current) {
        historyBusy.current = false;
        if (mounted.current && generation === historyGeneration.current)
          setLoading(false);
      }
    }
  }
  useEffect(() => {
    historyGeneration.current++;
    historyBusy.current = false;
    setItems([]);
    setCursor(null);
    setLoading(false);
    void history();
  }, [id, tab, effectiveRun]);
  // Poll the first page while inspecting current history; preserve older loaded pages until explicit refresh.
  useEffect(() => {
    if (["overview", "configuration"].includes(tab)) return;
    const timer = setInterval(() => {
      if (items.length <= 25) void history();
    }, 5000);
    return () => clearInterval(timer);
  }, [id, tab, effectiveRun, items.length, cursor]);
  if (!snapshot)
    return (
      <section id="bot-monitor" className="panel bot-monitor">
        <button onClick={onClose}>Close monitor</button>
        <h2>Opening bot monitor…</h2>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const b = snapshot.bot,
    m = snapshot.monitoring,
    s = m?.snapshot ?? {},
    p = snapshot.position,
    summary = snapshot.summary;
  const reasons = [
    ...new Set<string>([
      ...snapshot.blockers,
      ...(m?.error_snapshot?.reasons ?? []),
      ...(s.reasons ?? []),
    ]),
  ];
  if (
    b.status === "RISK_LOCKED" &&
    !m?.error_snapshot &&
    snapshot.latestFailure
  )
    reasons.push(
      snapshot.latestFailure.reason ?? snapshot.latestFailure.action,
    );
  const active = ["STARTING", "RUNNING"].includes(b.status),
    price = m?.price;
  const cell = (row: any, key: string) => {
    const value = row[key];
    if (value === null || value === undefined) return "—";
    if (
      [
        "created_at",
        "updated_at",
        "executed_at",
        "closed_at",
        "started_at",
        "stopped_at",
      ].includes(key)
    )
      return when(value);
    if (key === "side") return value === "Buy" ? "BUY · Entry" : "SELL · Exit";
    if (key === "data")
      return `${value.direction ?? ""} · ${[...(value.reason ?? value.reasons ?? [])].join("; ")}`;
    if (key === "decision")
      return `${value.approved ? "APPROVED" : "NOT APPROVED"} · ${(value.reasons ?? []).join("; ")}`;
    if (key === "indicators") return value ? JSON.stringify(value) : "—";
    if (key === "result")
      return value
        ? `${value.action ?? value.marketRegime ?? ""} · confidence ${value.confidence ?? "—"} · ${value.recommendation ?? ""} · ${(value.reasons ?? []).join("; ")}`
        : "—";
    if (key === "realized_net" && row.side === "Buy")
      return "— (entry fee recorded separately)";
    return String(value);
  };
  const columns: Record<string, [string, string][]> = {
    fills: [
      ["executed_at", "Fill time"],
      ["side", "In / out"],
      ["quantity", "Filled qty"],
      ["price", "Price"],
      ["fee", "Fee (USDT equivalent)"],
      ["fee_currency", "Original fee asset"],
      ["realized_net", "Realized net on exit"],
      ["order_id", "Order"],
      ["run_id", "Run"],
    ],
    orders: [
      ["created_at", "Created"],
      ["side", "Side"],
      ["order_type", "Type"],
      ["quantity", "Requested qty"],
      ["limit_price", "Limit price"],
      ["state", "State"],
      ["updated_at", "Updated"],
      ["exchange_id", "Exchange order"],
      ["run_id", "Run"],
    ],
    cycles: [
      ["closed_at", "Closed"],
      ["net_pnl", "Cycle net P&L"],
      ["strategy_version", "Strategy"],
      ["closing_execution_id", "Closing fill"],
      ["run_id", "Closing order run"],
    ],
    signals: [
      ["created_at", "Evaluated"],
      ["data", "Strategy signal"],
      ["decision", "Risk / execution decision"],
      ["strategy_version", "Version"],
      ["run_id", "Run"],
    ],
    ai: [
      ["created_at", "Analyzed"],
      ["mode", "Mode"],
      ["provider", "Provider"],
      ["model", "Model"],
      ["indicators", "Analyzed indicators"],
      ["status", "Status"],
      ["result", "Analysis"],
      ["error_code", "Failure"],
    ],
    activity: [
      ["created_at", "Time"],
      ["action", "Action"],
      ["reason", "Reason"],
      ["exchange_code", "Exchange code"],
    ],
    events: [
      ["created_at", "Time"],
      ["order_id", "Order"],
      ["state", "State"],
      ["event_key", "Event"],
    ],
    runs: [
      ["started_at", "Tracking started"],
      ["stopped_at", "Stopped"],
      ["stop_reason", "Stop reason"],
      ["origin", "Origin"],
      ["id", "Run ID"],
    ],
  };
  return (
    <section
      id="bot-monitor"
      className="panel bot-monitor"
      aria-label="Bot monitoring panel"
    >
      <div className="row monitor-header">
        <div>
          <div className="eyebrow">
            BOT MONITOR · {b.environment} · {b.provider}
          </div>
          <h2>{b.name}</h2>
          <p>
            {b.symbol} · Spot ·{" "}
            {b.timeframe === "60" ? "1h" : `${b.timeframe}m`} ·{" "}
            {b.strategy_version} · {b.connection_name}
          </p>
        </div>
        <button onClick={onClose}>Close monitor ✕</button>
      </div>
      <div className="monitor-state">
        <strong
          className={"status " + (b.status === "RUNNING" ? "running" : "")}
        >
          {text(b.status)}
        </strong>
        <span>
          Worker: {snapshot.workerFresh ? "recent check" : "stale / unknown"}
        </span>
        <span>
          Testnet execution: {snapshot.executionEnabled ? "On" : "Off"}
        </span>
        <span>Exchange: {text(b.connection_status)}</span>
      </div>
      <div className="actions">
        {["start", "pause", "stop"].map((action) => (
          <button
            key={action}
            disabled={
              !!pending ||
              !snapshot.actions[action] ||
              !botActionEnabled(knownStatus ?? b.status, action) ||
              !!error
            }
            onClick={async () => {
              await onAction(action);
              try {
                const next = await request(`/bots/${id}/monitor`);
                if (mounted.current) setSnapshot(next);
              } catch (e) {
                if (mounted.current) setError((e as Error).message);
              }
            }}
          >
            {pending === action
              ? "Sending…"
              : action === "start" && b.status === "RISK_LOCKED"
                ? "Retry start checks"
                : text(action)}
          </button>
        ))}
      </div>
      <p className="muted">
        Updated {when(snapshot.serverTime)} · refreshes every 5s · times shown
        in your browser timezone.
      </p>
      {error && (
        <p role="alert" className="monitor-alert">
          Refresh failed: {error}. The snapshot above is the last successful
          response and may be stale.
        </p>
      )}
      {reasons.length > 0 && (
        <div className="monitor-alert" role="status">
          <h3>
            {b.status === "RISK_LOCKED"
              ? "Why execution is locked"
              : "Checks and last recorded blockers"}
          </h3>
          {reasons.map((reason) => (
            <p key={reason}>
              <strong>{text(reason)}</strong> —{" "}
              {descriptions[reason] ??
                "Review the recorded state, decisions and exchange events below."}
            </p>
          ))}
          {m?.error_at && (
            <small>
              Last blocked check: {when(m.error_at)}
              {m.error_snapshot?.exchangeCode
                ? ` · Exchange code ${m.error_snapshot.exchangeCode}`
                : ""}
            </small>
          )}
        </div>
      )}
      <div
        className="monitor-tabs"
        role="tablist"
        aria-label="Bot monitor sections"
      >
        {tabs.map(([key, label]) => (
          <button
            role="tab"
            aria-selected={tab === key}
            key={key}
            className={tab === key ? "selected" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <>
          <div className="monitor-metrics">
            {[
              ["Tracked Spot quantity", Number(p?.quantity ?? 0).toFixed(8)],
              ["Average entry", money(summary.averageEntry)],
              [
                "Last observed price",
                price
                  ? `${money(price)}${snapshot.priceFresh ? "" : " · stale"}`
                  : "Unavailable",
              ],
              ["Unrealized P&L", money(summary.unrealizedPnl)],
              [
                "Realized gross less all recorded fees",
                money(summary.realizedNetPnl),
              ],
              ["Bot equity estimate", money(summary.equity)],
              ["Recorded fees", money(p?.fees ?? 0)],
              [
                "Filled orders / fills",
                `${summary.filled_orders} / ${summary.fills}`,
              ],
              ["Closed position cycles", String(summary.closed_cycles)],
              [
                "Closed cycle wins / losses",
                `${summary.wins} / ${summary.losses}`,
              ],
              ["Open / unresolved orders", String(snapshot.openOrders.length)],
              [
                "AI mode",
                b.strategy_version === "ai-v1.0"
                  ? `STRATEGY · ${b.ai_strategy_config?.model}`
                  : (b.ai_mode ?? "OFF"),
              ],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <p className="muted">
            Lifetime bot totals. Orders are requests; fills are actual recorded
            entries/exits. Closed cycles represent positions fully exited,
            including recorded fees. Position is bot-attributed Spot inventory,
            not your whole exchange account. Equity/unrealized P&L are
            unavailable when the latest mark is stale. No pending-order reserve
            is added to equity.
          </p>
          <section>
            <h3>Account inventory isolation</h3>
            <p className="muted">
              Existing holdings are excluded from bot capital, positions and
              P&amp;L. Bots sell only inventory recorded in their own ledger.
            </p>
            {snapshot.inventory ? (
              <dl>
                <dt>Asset</dt>
                <dd>{snapshot.inventory.asset}</dd>
                <dt>Non-bot holdings at enrollment</dt>
                <dd>{snapshot.inventory.external_quantity}</dd>
                <dt>All bots on this connection</dt>
                <dd>{snapshot.inventory.managed_quantity}</dd>
                <dt>Last reconciled account total</dt>
                <dd>{snapshot.inventory.last_total}</dd>
                <dt>Last inventory check</dt>
                <dd>{when(snapshot.inventory.last_checked_at)}</dd>
              </dl>
            ) : (
              <p>
                Inventory baseline will be captured during the first successful
                start checks.
              </p>
            )}
            {m?.error_snapshot?.inventory && (
              <p role="status">
                Last mismatch: expected {m.error_snapshot.inventory.expected},
                exchange reported {m.error_snapshot.inventory.actual}{" "}
                {m.error_snapshot.inventory.asset}.
              </p>
            )}
          </section>
          <div className="monitor-grid">
            <section>
              <h3>Worker and market monitoring</h3>
              <dl>
                <dt>Last worker observation</dt>
                <dd>{when(m?.checked_at)}</dd>
                <dt>Last completed check</dt>
                <dd>{when(m?.last_success_at)}</dd>
                <dt>Worker stage</dt>
                <dd>{text(s.stage)}</dd>
                <dt>Private order/fill stream</dt>
                <dd>
                  {s.privateReady === undefined
                    ? "Unknown"
                    : s.privateReady
                      ? "Ready at last check"
                      : "Not ready at last check"}
                </dd>
                <dt>Market event received</dt>
                <dd>
                  {s.marketReceivedAt
                    ? when(s.marketReceivedAt)
                    : "Not recorded"}
                </dd>
                <dt>Last price observed</dt>
                <dd>{when(m?.price_at)}</dd>
                <dt>Connection reconciled</dt>
                <dd>{when(b.reconciled_at)}</dd>
                <dt>Last evaluated candle</dt>
                <dd>
                  {b.last_candle
                    ? when(Number(b.last_candle))
                    : "Not evaluated"}
                </dd>
                <dt>Evaluation cadence</dt>
                <dd>
                  {!active
                    ? "No new entries while inactive"
                    : b.strategy_version.startsWith("trend") ||
                        b.strategy_version.startsWith("breakout") ||
                        b.strategy_version.startsWith("custom") ||
                        b.strategy_version.startsWith("ai-")
                      ? `On a new closed ${b.timeframe === "60" ? "1h" : b.timeframe + "m"} candle; positions checked between candles`
                      : "Each worker cycle when data and account checks are ready"}
                </dd>
                <dt>Software stop level (last computation)</dt>
                <dd>
                  {Number(p?.quantity) > 0 && s.protection
                    ? money(s.protection.stopPrice)
                    : "Not available"}
                </dd>
                <dt>Software take-profit level</dt>
                <dd>
                  {Number(p?.quantity) > 0 && s.protection
                    ? money(s.protection.takeProfitPrice)
                    : "Not available"}
                </dd>
                <dt>Protection mode</dt>
                <dd>
                  {s.protection ? text(s.protection.reason) : "Not recorded"} ·
                  not proof of exchange-native stop orders
                </dd>
                <dt>Next nominal candle close</dt>
                <dd>
                  {active
                    ? when(
                        Math.floor(
                          new Date(snapshot.serverTime).getTime() /
                            (Number(b.timeframe) * 60000),
                        ) *
                          (Number(b.timeframe) * 60000) +
                          Number(b.timeframe) * 60000,
                      )
                    : "Bot inactive"}
                </dd>
                <dt>Current tracked run</dt>
                <dd>
                  {snapshot.activeRun
                    ? `${snapshot.activeRun.id} · since ${when(snapshot.activeRun.started_at)}`
                    : "No open run"}
                </dd>
              </dl>
            </section>
            <section>
              <h3>Latest strategy and risk decision</h3>
              {snapshot.lastSignal ? (
                <>
                  <p>
                    {when(snapshot.lastSignal.created_at)} ·{" "}
                    {text(snapshot.lastSignal.data?.direction)}
                  </p>
                  <p>
                    {(snapshot.lastSignal.data?.reason ?? []).join(" · ") ||
                      "No technical explanation recorded"}
                  </p>
                  <p>
                    {snapshot.lastSignal.decision?.approved
                      ? "Approved intent"
                      : "Not approved for submission"}{" "}
                    ·{" "}
                    {(snapshot.lastSignal.decision?.reasons ?? [])
                      .map(text)
                      .join(" · ") || "See signal details"}
                  </p>
                </>
              ) : (
                <p>
                  No signal has been recorded. Check worker/data readiness
                  above; starting a bot does not guarantee a trade.
                </p>
              )}
              <h3>Current open / unresolved orders</h3>
              {snapshot.openOrders.length ? (
                <ul>
                  {snapshot.openOrders.map((o: any) => (
                    <li key={o.id}>
                      {o.side} {o.quantity} {o.symbol} · {o.order_type} ·{" "}
                      {text(o.state)} · {when(o.updated_at)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No open or unresolved orders recorded.</p>
              )}
              <h3>Risk configuration</h3>
              <p>
                Allocation {money(b.config.capital)} · max trade{" "}
                {money(b.config.maxTrade)} · SL {b.config.stopLossPct}% · TP{" "}
                {b.config.takeProfitPct}% · daily loss ceiling{" "}
                {money(b.config.dailyLoss)} · max trades/day{" "}
                {b.config.maxTrades} · consecutive losses{" "}
                {b.config.maxConsecutiveLosses}
              </p>
            </section>
          </div>
        </>
      )}
      {tab === "configuration" && (
        <div className="monitor-grid">
          <section>
            <h3>Base risk limits</h3>
            <dl>
              {Object.entries(b.config).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{text(k)}</dt>
                  <dd>{String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
          <section>
            <h3>Strategy configuration</h3>
            <p>{b.strategy_version}</p>
            <dl>
              {Object.entries(b.advanced_config ?? {}).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{text(k)}</dt>
                  <dd>{String(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        </div>
      )}
      {!["overview", "configuration"].includes(tab) && (
        <>
          <div className="monitor-history-controls">
            {filterable && tab !== "runs" && (
              <label>
                History scope
                <select
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                >
                  <option value="">All runs, including legacy history</option>
                  {snapshot.activeRun &&
                    !runs.some((r) => r.id === snapshot.activeRun.id) && (
                      <option value={snapshot.activeRun.id}>
                        Current run · {when(snapshot.activeRun.started_at)}
                      </option>
                    )}
                  {runId &&
                    !runs.some((r) => r.id === runId) &&
                    runId !== snapshot.activeRun?.id && (
                      <option value={runId}>Selected run · {runId}</option>
                    )}
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {when(r.started_at)} · {r.stopped_at ? "Stopped" : "Open"}{" "}
                      · {r.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button disabled={loading} onClick={() => void history()}>
              Refresh history
            </button>
          </div>
          <p className="muted">
            {tab === "fills"
              ? "Each row is an actual reconciled exchange fill. Partial fills stay separate; Buy is entry, Sell is exit. A fill may arrive after Stop and remains linked to its order’s run."
              : tab === "cycles"
                ? "Net results of fully closed position cycles. Run filtering follows the closing order; a position may span runs."
                : tab === "runs"
                  ? "Runs track Start through Stop. Pause and retries keep the same open run. Monitoring adopted on an older active bot does not establish its original start time."
                  : tab === "activity" || tab === "ai"
                    ? "Lifetime bot records; not filtered by run."
                    : "Recorded history remains available after Stop."}{" "}
            Older history loads on demand; the live snapshot above continues
            refreshing. A list refreshed on its first page shows the newest
            records.
          </p>
          {historyError && <p role="alert">{historyError}</p>}
          <MonitorHistory
            tab={tab}
            items={items}
            columns={columns[tab] ?? []}
            cell={cell}
            onSelectRun={(id) => {
              setRunId(id);
              setTab("fills");
            }}
          />
          {!items.length && !loading && !historyError && (
            <div className="monitor-history-empty">
              <span className="history-overline">
                {tab === "ai"
                  ? "AI decision history"
                  : tab === "fills"
                    ? "Trade execution history"
                    : "Bot history"}
              </span>
              <h3>
                {tab === "ai"
                  ? "No AI decisions yet"
                  : tab === "fills"
                    ? "No fills yet"
                    : "No records yet"}
              </h3>
              <p>
                {tab === "ai"
                  ? "Completed analyses will appear here with the model, indicators and reasons behind each decision."
                  : tab === "fills"
                    ? "Actual entries and exits appear here after an approved order fills on the exchange."
                    : "Records will appear here as your bot runs. Try another history scope to see earlier activity."}
              </p>
            </div>
          )}
          {loading && <p>Loading history…</p>}
          {cursor && (
            <button disabled={loading} onClick={() => void history(true)}>
              Load older records
            </button>
          )}
        </>
      )}
      <p className="monitor-footnote">
        Pause/Stop prevent new entries and request cancellation of resting
        entries; they do not liquidate positions. Reconciliation may record
        later fills after Stop. Software exits require a healthy worker/exchange
        and enabled execution. External acceptance and native protection still
        need verification.
      </p>
    </section>
  );
}
