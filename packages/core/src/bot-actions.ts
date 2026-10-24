export function botActionEnabled(status: string, action: string) {
  if (action === "start")
    return [
      "STOPPED",
      "PAUSED",
      "RISK_LOCKED",
      "ERROR",
      "EXCHANGE_ERROR",
      "AI_ERROR",
    ].includes(status);
  if (action === "pause") return ["STARTING", "RUNNING"].includes(status);
  if (action === "stop")
    return !["STOPPED", "STOPPING", "ARCHIVED"].includes(status);
  return false;
}
