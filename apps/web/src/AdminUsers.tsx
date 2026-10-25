import React, { useEffect, useRef, useState } from "react";
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
const when = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString() : "Not recorded";
export function AdminUsers({ request }: { request: Request }) {
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<any>(null),
    [choice, setChoice] = useState("FREE"),
    [password, setPassword] = useState("");
  const generation = useRef(0);
  async function load() {
    const token = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await request(
        `/admin/users?search=${encodeURIComponent(query)}&offset=${offset}&limit=25`,
      );
      if (token === generation.current) setData(result);
    } catch (e) {
      if (token === generation.current) setError((e as Error).message);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setSelected(null);
    setPassword("");
    void load();
    return () => {
      generation.current++;
    };
  }, [query, offset]);
  const row = selected
    ? (data?.accounts?.find(
        (a: any) => a.workspace_id === selected.workspace_id,
      ) ?? selected)
    : null;
  const cap = choice === "BILLING" ? null : data?.plans?.[choice]?.bots;
  return (
    <section className="panel admin-users">
      <div className="row">
        <div>
          <h2>Admin → Users & plans</h2>
          <p className="muted">
            View registered accounts and manage workspace subscriptions. The
            first setup administrator’s personal workspace has a protected
            unlimited entitlement.
          </p>
        </div>
        <button disabled={busy || saving} onClick={() => void load()}>
          Refresh accounts
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <form
        className="monitor-history-controls"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setQuery(search.trim());
        }}
      >
        <label>
          Find an account or workspace
          <input
            type="search"
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Email or workspace name"
          />
        </label>
        <button disabled={busy || saving}>Search</button>
      </form>
      {busy && !data && <p role="status">Loading accounts…</p>}
      {data && (
        <>
          <p className="muted">
            {data.total} matching account/workspace records · Page{" "}
            {Math.floor(offset / 25) + 1}
          </p>
          <div className="table-wrap monitor-history-surface">
            <table className="monitor-history-table admin-accounts">
              <thead>
                <tr>
                  {["Account", "Workspace", "Plan", "Usage", "Manage"].map(
                    (name) => (
                      <th key={name} scope="col">
                        {name}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a: any) => (
                  <tr key={a.user_id + ":" + a.workspace_id}>
                    <td data-label="Account">
                      <strong>{a.email}</strong>
                      <small>
                        {a.verified ? "Verified" : "Email unverified"}
                        {a.platform_admin ? " · Platform admin" : ""}
                      </small>
                      <details>
                        <summary>Account activity</summary>
                        <small>Joined {when(a.created_at)}</small>
                        <small>Last login {when(a.last_login)}</small>
                        <code>{a.user_id}</code>
                      </details>
                    </td>
                    <td data-label="Workspace">
                      {a.workspace_name ?? "No workspace"}
                      <small>{a.kind?.toLowerCase()}</small>
                    </td>
                    <td data-label="Plan">
                      <span className="history-badge positive">
                        {a.unlimited ? "∞ Unlimited" : a.effective_plan}
                      </span>
                      <small>
                        {a.unlimited
                          ? "Installation owner"
                          : a.admin_plan_override
                            ? "Admin assigned"
                            : "Billing / default"}
                      </small>
                    </td>
                    <td data-label="Usage">
                      <strong>
                        {a.bots} bots · {a.active_bots} active
                      </strong>
                      <small>{a.connections} exchange connections</small>
                      <small>
                        This month: {a.ai_usage} AI calls · {a.backtest_usage}{" "}
                        backtests
                      </small>
                    </td>
                    <td data-label="Manage">
                      {a.unlimited ? (
                        <span className="muted">Protected owner plan</span>
                      ) : (
                        <button
                          disabled={!a.workspace_id || saving}
                          onClick={() => {
                            setSelected(a);
                            setChoice(a.admin_plan_override ?? "BILLING");
                            setPassword("");
                            setNotice("");
                          }}
                        >
                          Manage plan
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.accounts.length && <p>No accounts match this search.</p>}
          <div className="monitor-history-controls">
            <button
              disabled={offset === 0 || busy || saving}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              ← Previous
            </button>
            <button
              disabled={offset + 25 >= data.total || busy || saving}
              onClick={() => setOffset(offset + 25)}
            >
              Next →
            </button>
          </div>
        </>
      )}
      {row && !row.unlimited && (
        <section className="admin-plan-editor">
          <h3>Manage {row.email}</h3>
          <p>
            {row.workspace_name} · Current effective plan:{" "}
            <strong>{row.effective_plan}</strong>
          </p>
          <p className="muted">
            Billing plan: {row.billing_plan ?? "FREE"} ·{" "}
            {row.billing_status ?? "No subscription"}. Admin assignments remain
            active until changed or returned to billing.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError("");
              setNotice("");
              try {
                await request(
                  `/admin/workspaces/${row.workspace_id}/plan`,
                  "PATCH",
                  { plan: choice === "BILLING" ? null : choice, password },
                );
                setPassword("");
                setNotice(
                  choice === "BILLING"
                    ? "Billing/default plan restored. Change recorded in the audit log."
                    : `${choice} plan assigned. Change recorded in the audit log.`,
                );
                await load();
              } catch (e) {
                setPassword("");
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="form-grid">
              <label>
                Assign plan
                <select
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                  disabled={saving}
                >
                  <option value="BILLING">Use billing / default plan</option>
                  {Object.entries(data?.plans ?? {}).map(
                    ([name, v]: [string, any]) => (
                      <option key={name} value={name}>
                        {name} · {v.bots} bots · {v.ai} AI calls/month
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Your administrator password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saving}
                />
              </label>
            </div>
            {cap != null && Number(row.bots) > cap && (
              <p className="monitor-alert">
                This workspace has {row.bots} bots; {choice} allows {cap}.
                Existing bots and positions are retained. New entries may be
                blocked until the workspace is within plan limits; exits remain
                available under the existing execution controls.
              </p>
            )}
            <p className="muted">
              Changes apply to subsequent requests and execution checks. Plan
              changes do not enable Live trading, remove capital limits or close
              positions.
            </p>
            <div className="monitor-history-controls">
              <button className="primary" disabled={saving || !password}>
                {saving ? "Saving…" : "Confirm plan change"}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setSelected(null);
                  setPassword("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
