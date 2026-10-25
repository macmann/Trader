import React from "react";
import { monitorTime } from "./monitor-time.ts";
const label = (v: unknown) =>
  String(v ?? "Unavailable")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
const number = (v: unknown, precision = 8) =>
  v === null || v === undefined
    ? "—"
    : Number.isFinite(Number(v))
      ? new Intl.NumberFormat("en-US", {
          maximumFractionDigits: precision,
        }).format(Number(v))
      : "—";
const usd = (v: unknown) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(Number(v));
function Badge({ value }: { value: unknown }) {
  const text = String(value ?? "Unknown"),
    tone = ["BUY", "LONG", "VALID", "APPROVED", "FILLED", "RUNNING"].includes(
      text.toUpperCase(),
    )
      ? "positive"
      : ["FAILED", "REJECTED", "EXIT", "SELL", "ERROR"].includes(
            text.toUpperCase(),
          )
        ? "negative"
        : "neutral";
  return <span className={`history-badge ${tone}`}>{label(text)}</span>;
}
function References({ row }: { row: any }) {
  const refs = [
    ["Order", row.order_id ?? row.id],
    ["Exchange order", row.exchange_id],
    ["Run", row.run_id],
  ].filter(([, v]) => v);
  return (
    <details className="history-references">
      <summary>References</summary>
      {refs.map(([name, value]) => (
        <div key={name}>
          <span>{name}</span>
          <code>{value}</code>
        </div>
      ))}
    </details>
  );
}
export function MonitorHistory({
  tab,
  items,
  columns,
  cell,
  onSelectRun,
}: {
  tab: string;
  items: any[];
  columns: [string, string][];
  cell: (row: any, key: string) => React.ReactNode;
  onSelectRun: (id: string) => void;
}) {
  if (!items.length) return null;
  if (tab === "ai")
    return (
      <div className="analysis-history" aria-label="AI decision history">
        {items.map((row) => {
          const result = row.result,
            confidence = Number(result?.confidence),
            indicators = Object.entries(row.indicators ?? {});
          return (
            <article className="analysis-record" key={row.id}>
              <header className="analysis-record-header">
                <div>
                  <span className="history-overline">
                    {row.mode === "STRATEGY"
                      ? "AI strategy decision"
                      : "Market analysis"}
                  </span>
                  <h3>
                    {result
                      ? label(
                          result.action ??
                            result.recommendation ??
                            result.marketRegime,
                        )
                      : "Analysis unavailable"}
                  </h3>
                  <time>{monitorTime(row.created_at)}</time>
                </div>
                <Badge value={row.status} />
              </header>
              <div className="analysis-record-meta">
                <span>
                  {label(row.provider)}{" "}
                  <strong>{row.model ?? "Model unavailable"}</strong>
                </span>
                <span>{label(row.mode)} mode</span>
                {result?.marketRegime && (
                  <span>{label(result.marketRegime)}</span>
                )}
              </div>
              {result && Number.isFinite(confidence) && (
                <div className="analysis-confidence">
                  <span>
                    Confidence <strong>{number(confidence, 0)}%</strong>
                  </span>
                  <div
                    role="meter"
                    aria-label="AI confidence"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={confidence}
                  >
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(0, confidence))}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              {indicators.length > 0 && (
                <section
                  className="analysis-indicators"
                  aria-label="Indicators used"
                >
                  {indicators.map(([key, value]) => (
                    <div key={key}>
                      <span>
                        {key
                          .replaceAll("_", " ")
                          .replace(/([A-Za-z])(\d)/, "$1 $2")}
                      </span>
                      <strong>{number(value, 4)}</strong>
                    </div>
                  ))}
                </section>
              )}
              {!!result?.reasons?.length && (
                <section className="analysis-reasons">
                  <h4>Why this decision</h4>
                  <ul>
                    {result.reasons.map((reason: string, i: number) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                </section>
              )}
              {row.error_code && (
                <p className="history-failure">
                  <strong>Analysis could not complete</strong>
                  <span>{label(row.error_code)}</span>
                </p>
              )}
              <footer className="analysis-record-footer">
                AI recommendations pass through risk checks before an order can
                be placed.
              </footer>
            </article>
          );
        })}
      </div>
    );
  if (tab === "fills")
    return (
      <div className="table-wrap monitor-history-surface">
        <table className="monitor-history-table fills-history">
          <caption className="sr-only">
            Actual exchange entries and exits
          </caption>
          <thead>
            <tr>
              {[
                "Time / action",
                "Quantity",
                "Fill price",
                "Fees",
                "Realized P&L",
                "Details",
              ].map((t) => (
                <th scope="col" key={t}>
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td data-label="Time / action">
                  <div className="history-cell-stack">
                    <Badge
                      value={
                        row.market_type === "LINEAR"
                          ? row.position_direction
                          : row.side === "Buy"
                            ? "BUY"
                            : "SELL"
                      }
                    />
                    <strong>
                      {(
                        row.market_type === "LINEAR"
                          ? row.purpose === "ENTRY"
                          : row.side === "Buy"
                      )
                        ? "Entry fill"
                        : "Exit fill"}
                    </strong>
                    <time>{monitorTime(row.executed_at)}</time>
                  </div>
                </td>
                <td data-label="Quantity" className="history-number">
                  <strong>{number(row.quantity)}</strong>
                  <small>
                    {row.symbol?.replace(/USDT$/, "") ?? "Base asset"}
                  </small>
                </td>
                <td data-label="Fill price" className="history-number">
                  <strong>{usd(row.price)}</strong>
                  <small>USDT quote</small>
                </td>
                <td data-label="Fees" className="history-number">
                  <strong>{usd(row.fee)}</strong>
                  <small>USDT equivalent</small>
                  {row.fee_currency && (
                    <small>
                      Charged in {row.fee_currency}
                      {row.fee_amount != null
                        ? ` · ${number(row.fee_amount)}`
                        : ""}
                    </small>
                  )}
                </td>
                <td
                  data-label="Realized P&L"
                  className={`history-number ${(row.market_type === "LINEAR" ? row.purpose === "EXIT" : row.side === "Sell") && Number(row.realized_net) !== 0 ? (Number(row.realized_net) > 0 ? "history-profit" : "history-loss") : ""}`}
                >
                  <strong>
                    {(
                      row.market_type === "LINEAR"
                        ? row.purpose === "ENTRY"
                        : row.side === "Buy"
                    )
                      ? "—"
                      : usd(row.realized_net)}
                  </strong>
                  <small>
                    {(
                      row.market_type === "LINEAR"
                        ? row.purpose === "ENTRY"
                        : row.side === "Buy"
                    )
                      ? "Recorded on exit"
                      : "Net on this exit fill"}
                  </small>
                </td>
                <td data-label="Details">
                  <References row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="table-wrap monitor-history-surface">
      <table className="monitor-history-table">
        <caption className="sr-only">{label(tab)} history</caption>
        <thead>
          <tr>
            {columns.map(([key, name]) => (
              <th scope="col" key={key}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id}>
              {columns.map(([key, name]) => (
                <td key={key} data-label={name}>
                  {["state", "status"].includes(key) ? (
                    <Badge value={row[key]} />
                  ) : key.endsWith("_id") || key === "id" ? (
                    <details className="history-references">
                      <summary>
                        <code>
                          {String(row[key] ?? "—").slice(0, 8)}
                          {row[key] ? "…" : ""}
                        </code>
                      </summary>
                      <code>{row[key] ?? "Unavailable"}</code>
                    </details>
                  ) : (
                    cell(row, key)
                  )}
                  {tab === "runs" && key === "id" && (
                    <button
                      className="history-run-link"
                      onClick={() => onSelectRun(row.id)}
                    >
                      View entries / exits →
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
