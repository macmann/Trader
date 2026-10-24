import React, { useEffect, useState } from "react";
type Request = (path: string, method?: string, data?: unknown) => Promise<any>;
const defaultRule = () => ({
  left: { indicator: "RSI", period: 14 },
  operator: "GT",
  right: 50 as any,
});
const indicators = ["RSI", "EMA", "MA", "PRICE", "VOLUME_RATIO"];
export function strategyFields(data: FormData) {
  const strategy = String(data.get("strategyVersion"));
  return {
    timeframe: data.get("timeframe"),
    customStrategyId:
      strategy === "custom-v1.0" ? data.get("customStrategyId") : null,
    ...(strategy === "ai-v1.0"
      ? {
          aiStrategyConfig: {
            model: data.get("aiModel"),
            minConfidence: Number(data.get("minConfidence")),
          },
        }
      : {}),
  };
}
export function StrategyFields({
  request,
  bot,
  strategies = [
    { id: "trend-v1.0", name: "Trend confirmation" },
    { id: "breakout-v1.0", name: "Volume breakout" },
    { id: "dca-v1.0", name: "Bounded DCA" },
    { id: "custom-v1.0", name: "Custom indicator rules" },
    { id: "ai-v1.0", name: "AI Strategy" },
  ],
}: {
  request: Request;
  bot?: any;
  strategies?: any[];
}) {
  const [strategy, setStrategy] = useState(
      bot?.strategy_version ?? "trend-v1.0",
    ),
    [customId, setCustomId] = useState(bot?.custom_strategy_id ?? ""),
    [model, setModel] = useState(bot?.ai_strategy_config?.model ?? ""),
    [templates, setTemplates] = useState<any[]>([]),
    [models, setModels] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([request("/strategies"), request("/strategies/models")])
      .then(([t, m]) => {
        setTemplates(t);
        setModels(m);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Strategy
        <select
          name="strategyVersion"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
        >
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Candle interval
        <select name="timeframe" defaultValue={bot?.timeframe ?? "15"}>
          <option value="15">15 minutes</option>
          <option value="30">30 minutes</option>
          <option value="60">1 hour</option>
        </select>
      </label>
      {strategy === "custom-v1.0" && (
        <label>
          Saved strategy version
          <select
            name="customStrategyId"
            required
            value={customId}
            onChange={(e) => setCustomId(e.target.value)}
          >
            <option value="">Select a saved version</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · v{t.version}
              </option>
            ))}
          </select>
          <span className="muted">
            Create reusable rules in Strategies. Saved versions never change
            existing bots.
          </span>
        </label>
      )}
      {strategy === "ai-v1.0" && (
        <>
          <label>
            AI model · {models?.provider ?? "loading"}
            <select
              name="aiModel"
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Select model</option>
              {models?.models?.map((m: string) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Minimum AI confidence (%)
            <input
              type="number"
              name="minConfidence"
              min="0"
              max="100"
              step="1"
              defaultValue={bot?.ai_strategy_config?.minConfidence ?? 70}
              required
            />
          </label>
          <p className="muted">
            AI proposes Buy, Hold or Exit once per completed candle. Risk limits
            and stop-loss checks remain active between candles. Invalid or
            unavailable AI holds the position under existing risk protection.{" "}
            {models &&
              !models.configured &&
              "Configure the AI provider and key in Admin Settings before using AI Strategy."}
          </p>
        </>
      )}
    </>
  );
}
export function StrategyCreator({ request }: { request: Request }) {
  const [templates, setTemplates] = useState<any[]>([]),
    [previous, setPrevious] = useState(""),
    [name, setName] = useState("My RSI trend"),
    [rules, setRules] = useState<any>({
      entry: [defaultRule()],
      exit: [{ ...defaultRule(), operator: "LT", right: 40 }],
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = () => request("/strategies").then(setTemplates);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  function update(side: string, index: number, patch: any) {
    setRules((old: any) => ({
      ...old,
      [side]: old[side].map((rule: any, i: number) =>
        i === index ? { ...rule, ...patch } : rule,
      ),
    }));
  }
  return (
    <section className="panel">
      <h2>Strategy creator</h2>
      <p className="muted">
        All entry conditions must match to buy. While a bot owns a position, all
        exit conditions must match to close it. Stop loss and take profit can
        exit independently. MA is a simple moving average; RSI uses the selected
        rolling period.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label>
        Load a version to revise
        <select
          value={previous}
          onChange={(e) => {
            setPrevious(e.target.value);
            const t = templates.find((t) => t.id === e.target.value);
            if (t) {
              setName(t.name);
              setRules(t.rules);
            }
          }}
        >
          <option value="">New strategy</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · v{t.version}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setNotice("");
          try {
            const saved = await request("/strategies", "POST", {
              name,
              rules,
              ...(previous ? { previousVersionId: previous } : {}),
            });
            setNotice(
              `Saved version ${saved.version}. Select it when creating or configuring a stopped bot.`,
            );
            setPrevious(saved.id);
            await load();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Strategy name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {["entry", "exit"].map((side) => (
          <fieldset key={side}>
            <legend>
              {side === "entry"
                ? "Entry conditions · all must match"
                : "Exit conditions · all must match"}
            </legend>
            {rules[side].map((rule: any, i: number) => (
              <div className="form-grid" key={i}>
                <label>
                  Indicator
                  <select
                    value={rule.left.indicator}
                    onChange={(e) =>
                      update(side, i, {
                        left: { ...rule.left, indicator: e.target.value },
                      })
                    }
                  >
                    {indicators.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Period
                  <input
                    type="number"
                    min="2"
                    max="100"
                    step="1"
                    value={rule.left.period}
                    required
                    onChange={(e) =>
                      update(side, i, {
                        left: { ...rule.left, period: Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  Condition
                  <select
                    value={rule.operator}
                    onChange={(e) =>
                      update(side, i, { operator: e.target.value })
                    }
                  >
                    <option value="GT">Greater than</option>
                    <option value="LT">Less than</option>
                    <option value="CROSS_ABOVE">Crosses above</option>
                    <option value="CROSS_BELOW">Crosses below</option>
                  </select>
                </label>
                <label>
                  Compare with
                  <select
                    value={
                      typeof rule.right === "number" ? "VALUE" : "INDICATOR"
                    }
                    onChange={(e) =>
                      update(side, i, {
                        right:
                          e.target.value === "VALUE"
                            ? 50
                            : { indicator: "EMA", period: 21 },
                      })
                    }
                  >
                    <option value="VALUE">Numeric value</option>
                    <option value="INDICATOR">Another indicator</option>
                  </select>
                </label>
                {typeof rule.right === "number" ? (
                  <label>
                    Value
                    <input
                      type="number"
                      min="0"
                      max="1000000000000"
                      step="any"
                      required
                      value={rule.right}
                      onChange={(e) =>
                        update(side, i, { right: Number(e.target.value) })
                      }
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Compared indicator
                      <select
                        value={rule.right.indicator}
                        onChange={(e) =>
                          update(side, i, {
                            right: { ...rule.right, indicator: e.target.value },
                          })
                        }
                      >
                        {indicators.map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Compared period
                      <input
                        type="number"
                        min="2"
                        max="100"
                        step="1"
                        required
                        value={rule.right.period}
                        onChange={(e) =>
                          update(side, i, {
                            right: {
                              ...rule.right,
                              period: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  </>
                )}
                <button
                  type="button"
                  disabled={rules[side].length === 1}
                  onClick={() =>
                    setRules((old: any) => ({
                      ...old,
                      [side]: old[side].filter((_: any, n: number) => n !== i),
                    }))
                  }
                >
                  Remove condition
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={rules[side].length >= 10}
              onClick={() =>
                setRules((old: any) => ({
                  ...old,
                  [side]: [...old[side], defaultRule()],
                }))
              }
            >
              + Add condition
            </button>
          </fieldset>
        ))}
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : previous ? "Save new version" : "Save strategy"}
        </button>
      </form>
      <h3>Saved versions</h3>
      {templates.length ? (
        templates.map((t) => (
          <p key={t.id}>
            {t.name} · v{t.version} · {t.rules.entry.length} entry /{" "}
            {t.rules.exit.length} exit conditions
          </p>
        ))
      ) : (
        <p>No saved strategies yet.</p>
      )}
    </section>
  );
}
