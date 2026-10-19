import React, { useState, useEffect } from "react";
type Bot = {
  id: string;
  name: string;
  status: string;
  ai_mode?: string;
  symbol: string;
};
type Analysis = {
  id: string;
  bot_id: string;
  symbol: string;
  bot_name: string;
  mode: string;
  status: string;
  provider: string;
  model: string;
  created_at: string;
  expires_at: string;
  error_code: string | null;
  result: null | {
    marketRegime: string;
    directionBias: string;
    confidence: number;
    riskLevel: string;
    newsSentiment: number;
    recommendation: string;
    positionSizeModifier: number;
    reasons: string[];
  };
  comparison: {
    strategyAllowed: boolean;
    strategyPlusFilterAllowed: boolean;
    direction: string;
  };
};
type Article = {
  id: string;
  source: string;
  title: string;
  url: string;
  published_at: string;
  analysis_status: string;
  analysis: null | {
    summary: string;
    sentimentScore: number;
    impactScore: number;
    urgency: string;
    category: string;
    assetTags: string[];
  };
};
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
export function Intelligence({
  page,
  bots,
  request,
  refreshBots,
}: {
  page: string;
  bots: Bot[];
  request: Request;
  refreshBots: () => Promise<void>;
}) {
  const [analyses, setAnalyses] = useState<Analysis[]>([]),
    [news, setNews] = useState<Article[]>([]),
    [status, setStatus] = useState<any>(null),
    [comparison, setComparison] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    const [a, n, s, c] = await Promise.all([
      request("/ai/analyses" + (selected ? "?botId=" + selected : "")),
      request("/news"),
      request("/ai/status"),
      request("/ai/comparison"),
    ]);
    setAnalyses(a);
    setNews(n);
    setStatus(s);
    setComparison(c);
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
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
    let alive = true;
    void load().catch((e) => {
      if (alive) setError(e.message);
    });
    const timer = setInterval(() => void load().catch(() => {}), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected]);
  const latest = analyses.find((a) => a.status === "VALID" && a.result),
    r = latest?.result,
    stale = latest ? new Date(latest.expires_at).getTime() <= Date.now() : true;
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>
            {page === "News" ? "Market headlines" : "AI market intelligence"}
          </h2>
          <p className="muted">
            AI adds context. The strategy proposes trades and the Risk Engine
            retains final veto.
          </p>
        </div>
        <button disabled={busy} onClick={() => void action(load)}>
          Refresh
        </button>
      </div>
      {error && (
        <div className="message error" role="alert">
          {error.replaceAll("_", " ")}
        </div>
      )}
      {status && !status.ready && (
        <div className="message">
          AI is not configured. The platform owner must set a provider, model
          and API credential on the server. Advisory remains strategy-only;
          Filter blocks new entries without valid analysis.
        </div>
      )}
      {page !== "News" && (
        <>
          <section className="panel">
            <div className="section-heading">
              <h2>Bot analysis modes</h2>
              <span className="badge">LIVE DISABLED</span>
            </div>
            {!bots.length ? (
              <p className="muted">
                Create a bot to configure analysis and record decisions.
              </p>
            ) : (
              bots.map((b) => (
                <div className="ai-bot-row" key={b.id}>
                  <div>
                    <strong>{b.name}</strong>
                    <small>
                      {b.status} · {b.symbol} · 15m
                    </small>
                  </div>
                  <label>
                    <span className="sr-only">AI mode for {b.name}</span>
                    <select
                      value={b.ai_mode ?? "OFF"}
                      disabled={
                        busy ||
                        ["RUNNING", "STARTING", "STOPPING"].includes(b.status)
                      }
                      onChange={(e) => {
                        const mode = e.target.value;
                        void action(async () => {
                          await request(`/bots/${b.id}/ai`, "PATCH", { mode });
                          await refreshBots();
                        });
                      }}
                    >
                      <option value="OFF">Off</option>
                      <option value="ADVISORY">Advisory</option>
                      <option value="FILTER">Filter · fail closed</option>
                    </select>
                  </label>
                  <button
                    disabled={
                      busy || !status?.ready || (b.ai_mode ?? "OFF") === "OFF"
                    }
                    onClick={() =>
                      void action(async () => {
                        const v = await request(
                          `/bots/${b.id}/analyze`,
                          "POST",
                          {},
                        );
                        if (v.status === "FAILED")
                          throw Error(v.error ?? "AI_UNAVAILABLE");
                      })
                    }
                  >
                    Analyze now
                  </button>
                </div>
              ))
            )}
            <p className="muted">
              Stop a bot before changing its mode. Advisory never changes order
              size. Filter can skip or reduce a strategy candidate; AI cannot
              create an order or increase allocation.
            </p>
          </section>
          <div className="section-heading ai-heading">
            <h2>Latest validated market context</h2>
            <label>
              <span className="sr-only">Filter history by bot</span>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">All bots</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {r && latest ? (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <span className="badge">{latest.symbol} · 15m</span>
                  <h2>{r.marketRegime.replaceAll("_", " ")}</h2>
                </div>
                <span className={"status " + (!stale ? "running" : "")}>
                  {stale ? "STALE · CONTEXT ONLY" : "VALID AT LAST REFRESH"}
                </span>
              </div>
              <div className="metrics ai-metrics">
                {[
                  ["Confidence", `${r.confidence}%`],
                  ["Bias", r.directionBias],
                  ["Risk", r.riskLevel],
                  ["News sentiment", r.newsSentiment.toFixed(2)],
                ].map(([label, value]) => (
                  <div className="metric" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <h3>
                {r.recommendation.replaceAll("_", " ")} · Size ceiling{" "}
                {Math.round(r.positionSizeModifier * 100)}%
              </h3>
              <ul className="reasons">
                {r.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
              <p className="muted">
                {latest.bot_name} · {latest.mode} · {latest.provider}/
                {latest.model} · {new Date(latest.created_at).toLocaleString()}
                <br />
                This is market context, not a profit forecast. Filter applies a
                fresh validated result plus independent risk checks.
              </p>
            </section>
          ) : (
            <section className="panel empty">
              <h2>No validated AI context yet.</h2>
              <p>
                Enable Advisory for a stopped bot and request an analysis, or
                let the worker analyze its next closed candle. Missing results
                are shown in decision history.
              </p>
            </section>
          )}
          <section className="panel note">
            <h3>Strategy vs. AI Filter · decision comparison</h3>
            <div className="comparison-grid">
              {[
                ["Candidate snapshots", comparison?.candidate_signals ?? 0],
                [
                  "Strategy + risk approved",
                  comparison?.strategy_approved ?? 0,
                ],
                ["Would pass AI Filter", comparison?.filter_approved ?? 0],
                ["Failed analyses", comparison?.failed_analyses ?? 0],
              ].map(([label, value]) => (
                <div key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <p className="muted">
              Workspace totals compare recorded decisions, including manual and
              news-triggered snapshots. These are not unique trades or return
              comparisons. Performance comparisons need a verified trade ledger
              and controlled experiments.
            </p>
          </section>
          <div className="section-heading ai-heading">
            <h2>Decision history</h2>
            <span className="count">{analyses.length}</span>
          </div>
          <section className="panel">
            {!analyses.length ? (
              <p className="muted">No analyses recorded yet.</p>
            ) : (
              analyses.map((a) => (
                <details className="analysis-record" key={a.id}>
                  <summary>
                    <span>
                      <strong>{a.bot_name}</strong>
                      <small>
                        {new Date(a.created_at).toLocaleString()} · {a.mode}
                      </small>
                    </span>
                    <span className="badge">
                      {a.status === "VALID"
                        ? a.result?.recommendation
                        : a.error_code?.replaceAll("_", " ")}
                    </span>
                  </summary>
                  <p className="muted">
                    {a.provider}/{a.model} · Strategy {a.comparison.direction} ·
                    Strategy + risk{" "}
                    {a.comparison.strategyAllowed ? "ALLOW" : "SKIP"} ·
                    Counterfactual Filter{" "}
                    {a.comparison.strategyPlusFilterAllowed ? "ALLOW" : "SKIP"}
                  </p>
                  {a.result ? (
                    <>
                      <p>
                        {a.result.marketRegime.replaceAll("_", " ")} ·{" "}
                        {a.result.confidence}% confidence · {a.result.riskLevel}{" "}
                        risk
                      </p>
                      <ul className="reasons">
                        {a.result.reasons.map((v, i) => (
                          <li key={i}>{v}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="muted">
                      Analysis unavailable. Advisory remains strategy-only.
                      Filter rejects new entries. Existing risk controls remain
                      independent.
                    </p>
                  )}
                </details>
              ))
            )}
          </section>
        </>
      )}
      {page === "News" && (
        <>
          {!news.length ? (
            <section className="panel empty">
              <h2>No market headlines yet.</h2>
              <p>
                News ingestion is opt-in and requires an AI provider. The worker
                polls curated public feeds every five minutes and analyzes at
                most five new headlines per cycle.
              </p>
            </section>
          ) : (
            <div className="news-grid">
              {news.map((a) => (
                <article className="panel" key={a.id}>
                  <div className="section-heading">
                    <span className="badge">{a.source}</span>
                    <small>{new Date(a.published_at).toLocaleString()}</small>
                  </div>
                  <h2>
                    <a href={a.url} target="_blank" rel="noopener noreferrer">
                      {a.title} ↗
                    </a>
                  </h2>
                  {a.analysis ? (
                    <>
                      <p className="muted">{a.analysis.summary}</p>
                      <div className="news-tags">
                        <span>{a.analysis.category.replaceAll("_", " ")}</span>
                        <span>
                          Sentiment {a.analysis.sentimentScore.toFixed(2)}
                        </span>
                        <span>
                          Impact {Math.round(a.analysis.impactScore * 100)}%
                        </span>
                        <span>{a.analysis.urgency} urgency</span>
                      </div>
                      <p className="muted">
                        {a.analysis.assetTags.join(" · ")}
                      </p>
                    </>
                  ) : (
                    <p className="muted">
                      {a.analysis_status === "FAILED"
                        ? "AI analysis unavailable."
                        : "Awaiting headline analysis."}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
          <section className="panel note">
            <h3>Headlines are untrusted market inputs.</h3>
            <p className="muted">
              AI classification is advisory context and may be wrong. The
              platform analyzes headlines, not full articles. A high-impact
              headline can refresh context; it never independently opens or
              liquidates a position.
            </p>
          </section>
        </>
      )}
    </>
  );
}
