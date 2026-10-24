import React, { useEffect, useState } from "react";
export function AdminSettings({
  request,
}: {
  request: (path: string, method?: string, data?: unknown) => Promise<any>;
}) {
  const [value, setValue] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void request("/admin/settings")
      .then(setValue)
      .catch((e) => setError(e.message));
  }, []);
  const secrets = [
    ["RESEND_API_KEY", "Resend API key"],
    ["AI_API_KEY", "AI API key"],
    ["TELEGRAM_BOT_TOKEN", "Telegram bot token"],
    ["BILLING_WEBHOOK_SECRET", "Billing webhook secret"],
  ];
  return (
    <section className="panel">
      <h2>Admin → Settings</h2>
      <p>
        Installation-wide settings. Saved secrets stay encrypted and are never
        displayed. Changes apply to new requests and worker cycles; in-flight
        requests may finish with their current settings.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {value && (
        <form
          key={JSON.stringify(value)}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget,
              data = new FormData(form);
            setBusy(true);
            setError("");
            setNotice("");
            const settings: Record<string, string> = {};
            for (const name of [
              "TRADING_EXECUTION_ENABLED",
              "MAIL_MODE",
              "MAIL_FROM",
              "AI_PROVIDER",
              "AI_MODEL",
              "AI_MAX_CALLS_PER_DAY",
              "NEWS_ENABLED",
            ])
              settings[name] = String(data.get(name) ?? "");
            for (const [name] of secrets) {
              if (data.get(`clear_${name}`)) settings[name] = "";
              else if (data.get(name)) settings[name] = String(data.get(name));
            }
            try {
              const next = await request("/admin/settings", "PUT", {
                password: data.get("password"),
                acknowledgeTestnetExecution:
                  data.get("acknowledgeTestnetExecution") === "on",
                settings,
              });
              form.reset();
              setValue(next);
              setNotice(
                "Settings saved. Existing secrets were preserved unless replaced or cleared.",
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Testnet order execution
            <select
              name="TRADING_EXECUTION_ENABLED"
              defaultValue={value.TRADING_EXECUTION_ENABLED}
            >
              <option value="false">Off (default)</option>
              <option value="true">On — Testnet only</option>
            </select>
          </label>
          <p>
            Enabling permits Testnet orders after bot and risk checks; it does
            not start stopped bots or enable Live trading. Disabling blocks new
            submissions, including software exits; it does not close positions.
            Cancellation and reconciliation continue. Orders already sent may
            still fill.
          </p>
          <label>
            <input type="checkbox" name="acknowledgeTestnetExecution" />I
            acknowledge that enabling Testnet execution permits automated
            simulated orders. Check this when switching from Off to On.
          </label>
          <label>
            Email delivery
            <select name="MAIL_MODE" defaultValue={value.MAIL_MODE}>
              <option value="disabled">
                Disabled — public registration unavailable
              </option>
              <option value="resend">Resend</option>
            </select>
          </label>
          <label>
            Sender address
            <input
              name="MAIL_FROM"
              defaultValue={value.MAIL_FROM}
              placeholder="Trading Bot <accounts@b-connect.site>"
              maxLength={254}
            />
          </label>
          <label>
            AI provider
            <select name="AI_PROVIDER" defaultValue={value.AI_PROVIDER}>
              {["disabled", "openai", "anthropic", "gemini", "deepseek"].map(
                (v) => (
                  <option key={v}>{v}</option>
                ),
              )}
            </select>
          </label>
          <label>
            AI model
            <input
              name="AI_MODEL"
              defaultValue={value.AI_MODEL}
              maxLength={128}
            />
          </label>
          <label>
            Maximum AI calls/day
            <input
              type="number"
              name="AI_MAX_CALLS_PER_DAY"
              defaultValue={value.AI_MAX_CALLS_PER_DAY}
              min={0}
              max={10000}
              required
            />
          </label>
          <label>
            News analysis
            <select name="NEWS_ENABLED" defaultValue={value.NEWS_ENABLED}>
              <option value="false">Off</option>
              <option value="true">On</option>
            </select>
          </label>
          {secrets.map(([name, label]) => (
            <div key={name}>
              <label>
                {label} —{" "}
                {value.configured[name] ? "Configured" : "Not configured"}
                <input
                  type="password"
                  name={name}
                  autoComplete="new-password"
                  placeholder="Leave blank to keep current value"
                />
              </label>
              <label>
                <input type="checkbox" name={`clear_${name}`} /> Clear saved{" "}
                {label}
              </label>
            </div>
          ))}
          <label>
            Confirm your account password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      )}
    </section>
  );
}
