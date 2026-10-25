import React, { useEffect, useRef, useState } from "react";
export function readableDiagnostics(report: any) {
  const lines = [
    "# Bot diagnostic report",
    `Generated: ${report.generatedAt}`,
    `Bot: ${report.bot.name} (${report.bot.id})`,
    `Status: ${report.bot.status} | ${report.bot.symbol} | ${report.bot.timeframe} minute candles | ${report.bot.strategy_version}`,
    `Period: ${report.window.since} to ${report.generatedAt} (UTC)`,
    "",
    "## Findings",
    ...report.summary.findings.map((s: string) => `- ${s}`),
    "",
    "## Record counts",
    ...Object.entries(report.history).map(
      ([name, group]: [string, any]) =>
        `- ${name}: ${group.included} exported of ${group.total}${group.truncated ? " — TRUNCATED" : ""}`,
    ),
    "",
    "## Configuration and current state",
    "```json",
    JSON.stringify(
      {
        bot: report.bot,
        controls: report.controls,
        monitoring: report.current,
        position: report.position,
        inventory: report.inventory,
        customStrategy: report.customStrategy,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Coverage",
    ...Object.values(report.coverage).map((value) => `- ${value}`),
  ];
  for (const [name, group] of Object.entries(report.history) as [
    string,
    any,
  ][]) {
    lines.push(
      "",
      `## ${name}`,
      `${group.included} of ${group.total} records. Latest first.${group.truncated ? " Export is truncated." : ""}`,
    );
    for (const record of group.records)
      lines.push("", "```json", JSON.stringify(record, null, 2), "```");
  }
  return lines.join("\n");
}
export function BotDiagnostics({
  id,
  request,
}: {
  id: string;
  request: (path: string) => Promise<any>;
}) {
  const [hours, setHours] = useState("24"),
    [report, setReport] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  async function load() {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await request(`/bots/${id}/diagnostics?hours=${hours}`);
      if (token === generation.current) setReport(result);
    } catch (e) {
      if (token === generation.current) setError((e as Error).message);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setReport(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [id, hours]);
  function download(format: "json" | "md") {
    if (!report) return;
    const blob = new Blob(
      [
        format === "json"
          ? JSON.stringify(report, null, 2)
          : readableDiagnostics(report),
      ],
      {
        type:
          format === "json"
            ? "application/json"
            : "text/markdown;charset=utf-8",
      },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `bot-${id}-diagnostics-${new Date(report.generatedAt).toISOString().replaceAll(":", "-")}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="bot-diagnostics">
      <div className="row">
        <div>
          <h3>Why hasn’t my bot traded?</h3>
          <p className="muted">
            Review recorded decisions and download a report for troubleshooting.
            This export contains trading history and settings; share it only
            with someone you trust.
          </p>
        </div>
        <label>
          Report period
          <select value={hours} onChange={(e) => setHours(e.target.value)}>
            <option value="1">Last hour</option>
            <option value="24">Last 24 hours</option>
            <option value="72">Last 3 days</option>
            <option value="168">Last 7 days</option>
            <option value="336">Last 14 days</option>
          </select>
        </label>
      </div>
      <div className="monitor-history-controls">
        <button disabled={busy} onClick={() => void load()}>
          {busy ? "Collecting diagnostics…" : "Refresh report"}
        </button>
        <button
          className="primary"
          disabled={busy || !report}
          onClick={() => download("md")}
        >
          Download readable report
        </button>
        <button disabled={busy || !report} onClick={() => download("json")}>
          Download JSON logs
        </button>
        <button
          disabled={!report}
          onClick={(e) => {
            e.currentTarget
              .closest(".bot-diagnostics")
              ?.querySelectorAll("details")
              .forEach((node) => (node.open = true));
            window.print();
          }}
        >
          Print
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p className="muted">
            Report generated {new Date(report.generatedAt).toLocaleString()} ·
            Refresh to include newer events.
          </p>
          <div className="monitor-alert">
            <h4>Recorded findings</h4>
            <ul>
              {report.summary.findings.map((finding: string, i: number) => (
                <li key={i}>{finding}</li>
              ))}
            </ul>
            <p>
              These findings describe the available records. They do not
              establish a single cause for the entire period.
            </p>
          </div>
          <div className="monitor-metrics">
            {[
              ["Evaluations", "signals"],
              ["Orders", "orders"],
              ["Actual fills", "fills"],
              ["AI decisions", "aiStrategy"],
              ["Worker events", "workerEvents"],
            ].map(([label, key]) => (
              <div className="metric" key={key}>
                <span>{label}</span>
                <strong>{report.summary.counts[key]}</strong>
              </div>
            ))}
          </div>
          <h4>Export coverage</h4>
          <ul>
            {Object.entries(report.history).map(
              ([key, value]: [string, any]) => (
                <li key={key}>
                  {key}: {value.included} of {value.total} records
                  {value.truncated ? " · latest records only (truncated)" : ""}
                </li>
              ),
            )}
          </ul>
          <p className="muted">
            Worker state changes and 10-minute heartbeats are retained for up to
            14 days. New indicator/rule diagnostics start after this deployment;
            older records cannot be reconstructed.
          </p>
          <h4>Latest strategy evaluation</h4>
          {report.history.signals.records[0] ? (
            <details open className="diagnostic-json">
              <summary>Decision, risk checks and indicator values</summary>
              <pre>
                {JSON.stringify(report.history.signals.records[0], null, 2)}
              </pre>
            </details>
          ) : (
            <p>No recorded strategy evaluation in this period.</p>
          )}
          <details className="diagnostic-json">
            <summary>Full report · printable logs</summary>
            <pre>{readableDiagnostics(report)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
