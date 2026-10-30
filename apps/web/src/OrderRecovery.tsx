import { monitorTime } from "./monitor-time.ts";
import React, { useEffect, useState } from "react";
export function OrderRecovery({
  snapshot,
  request,
  refresh,
}: {
  snapshot: any;
  request: (path: string, method?: string, data?: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const order = snapshot.openOrders?.find(
    (o: any) => o.state === "UNKNOWN" && !o.exchange_id,
  );
  useEffect(() => {
    setConfirmed(false);
    setPassword("");
    setMessage("");
  }, [order?.id]);
  if (!snapshot.recoveryAvailable || (!order && !snapshot.latestRecovery))
    return null;
  const pending = !!order?.recovery_requested_at;
  return (
    <section
      className="monitor-alert order-recovery"
      aria-label="Missing order recovery"
    >
      <h3>Resolve an unconfirmed order</h3>
      <p>
        This checks OKX Demo again without placing or resending a trade. If no
        activity is found and your confirmation agrees, the old order is
        retained as operator-resolved and the bot stays stopped.
      </p>
      {snapshot.latestRecovery && (
        <p>
          Last recovery:{" "}
          {snapshot.latestRecovery.action
            .replaceAll("MISSING_ORDER_RECOVERY_", "")
            .replaceAll("_", " ")}{" "}
          {snapshot.latestRecovery.data?.reason?.replaceAll("_", " ")}
        </p>
      )}
      {order && (
        <>
          <p>
            {order.side} {order.quantity} {order.symbol} · attempted{" "}
            {monitorTime(order.created_at)} · reference {order.client_id}
          </p>
          {pending ? (
            <p role="status">
              Recovery requested. Waiting for the worker to finish exchange
              checks; automatic retry may take up to five minutes.
            </p>
          ) : (
            <>
              <label className="recovery-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I checked this contract’s OKX Demo order and trade history, and
                there is no corresponding trade, open position or pending order.
              </label>
              <label>
                Confirm your platform password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !confirmed || !password}
                onClick={async () => {
                  setBusy(true);
                  setMessage("");
                  try {
                    await request("/auth/reauthenticate", "POST", { password });
                    setPassword("");
                    await request(
                      `/bots/${snapshot.bot.id}/recover-missing-order`,
                      "POST",
                      { orderId: order.id, confirmedNoExchangeActivity: true },
                    );
                    setConfirmed(false);
                    await refresh();
                    setMessage(
                      "Requested. The bot stays stopped after successful recovery. Review the result, then use Start.",
                    );
                  } catch (e) {
                    setMessage((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "Requesting checks…"
                  : "Verify and resolve missing order"}
              </button>
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
