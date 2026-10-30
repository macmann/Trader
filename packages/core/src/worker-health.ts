// Scheduled backoff is not a recent completed check, but is not an unexplained stale worker either.
export function workerHealth(monitor: any, now = Date.now()) {
  const checked = new Date(monitor?.checked_at ?? "invalid").getTime();
  const retry = monitor?.snapshot?.retryAt;
  const recent =
    Number.isFinite(checked) && now >= checked && now - checked < 120000;
  const waiting =
    Number.isFinite(checked) &&
    now >= checked &&
    ["RISK_LOCKED", "EXCHANGE_BACKOFF", "CHECK_FAILED"].includes(
      monitor?.snapshot?.stage,
    ) &&
    typeof retry === "number" &&
    Number.isFinite(retry) &&
    retry >= checked &&
    retry - checked <= 305000 &&
    now <= retry + 30000;
  return { recent, waiting, stale: !recent && !waiting };
}
