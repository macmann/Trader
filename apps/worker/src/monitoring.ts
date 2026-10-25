import { InventoryError } from "./inventory.ts";
import { tenant } from "../../api/src/db.ts";
import { ExchangeError } from "../../../packages/core/src/index.ts";
export type BotObservation = {
  stage: string;
  reasons: string[];
  privateReady?: boolean;
  marketReceivedAt?: number;
  price?: number;
  priceAt?: number;
  reconciled?: boolean;
  executionEnabled?: boolean;
  exchangeCode?: number;
  candleTime?: number;
  inventory?: InventoryError["details"];
  futures?: {
    leverage: number;
    marginMode: string;
    positionDirection: string;
    liquidationPrice: number | null;
  };
  protection?: {
    stopPrice: number;
    takeProfitPrice: number;
    highWatermark: number;
    exit: boolean;
    reason: string;
  };
};
export function failureObservation(error: unknown): BotObservation {
  const known = [
    "UNEXPECTED_ACCOUNT_POSITION",
    "UNEXPECTED_FUTURES_POSITION",
    "FUTURES_ISOLATED_1X_REQUIRED",
    "FUTURES_LEVERAGE_OR_MARGIN_MISMATCH",
    "STOP_LOSS_TOO_WIDE_FOR_LEVERAGE",
    "INVALID_LEVERAGE",
    "LEVERAGE_VERIFICATION_FAILED",
    "ONE_WAY_POSITION_MODE_REQUIRED",
    "ISOLATED_MARGIN_REQUIRED",
    "FUTURES_ENTRY_PRICE_MISMATCH",
    "FUTURES_DIRECTION_MISMATCH",
    "FUNDING_EVENT_INVALID",
    "FUNDING_PAGINATION_INVALID",
    "FUNDING_PAGINATION_LIMIT",
    "UNSUPPORTED_FUTURES_CONTRACT",
    "INVALID_CONTRACT_SIZE",
    "FUTURES_USDT_FEE_REQUIRED",
    "FUNDING_EVENT_CONFLICT",
    "STALE_FUTURES_MARKET",
    "FUTURES_REDUCE_ONLY_REQUIRED",
    "ACCOUNT_BALANCE_INVALID",
    "ACCOUNT_POSITION_INVALID",
    "INVENTORY_BASELINE_REVIEW_REQUIRED",
    "LEDGER_REBUILD_REQUIRED",
    "RECONCILIATION_WINDOW_EXCEEDED",
    "UNEXPECTED_EXCHANGE_ORDER",
    "UNEXPECTED_EXCHANGE_EXECUTION",
    "UNSUPPORTED_FEE_CURRENCY",
    "SELL_EXCEEDS_TRACKED_POSITION",
    "EXCHANGE_ORDER_IDENTITY_MISMATCH",
    "EXECUTION_ID_CONFLICT",
    "EXECUTION_ORDER_IDENTITY_MISMATCH",
    "EXECUTION_SIDE_MISMATCH",
    "EXECUTION_SYMBOL_MISMATCH",
    "FEE_CURRENCY_REQUIRED",
    "INVALID_EXCHANGE_FILL",
    "INVALID_EXECUTION_ID_OR_TIME",
    "INVALID_NET_FILL",
    "INVALID_RECONCILIATION_CURSOR",
    "INVALID_RECONCILIATION_PAGE",
    "INVALID_TERMINAL_QUANTITY",
    "LATE_FILL_FROM_PREVIOUS_CYCLE",
    "ORDER_OVERFILLED",
    "PAGINATED_HISTORY_CURSOR_REPEATED",
    "PAGINATED_HISTORY_LIMIT_REACHED",
    "UNSUPPORTED_EXECUTION_TYPE",
  ];
  return {
    ...(error instanceof InventoryError ? { inventory: error.details } : {}),
    stage: "CHECK_FAILED",
    reasons: [
      error instanceof ExchangeError
        ? error.status
        : error instanceof Error && known.includes(error.message)
          ? error.message
          : "WORKER_CHECK_FAILED",
    ],
    ...(error instanceof ExchangeError && Number.isSafeInteger(error.code)
      ? { exchangeCode: error.code }
      : {}),
  };
}
export async function recordObservation(
  tid: string,
  botId: string,
  value: BotObservation,
) {
  // Monitoring is separate from financial transactions and must not roll them back.
  if (value.reasons.includes("NO_WORKER_CHECK_RESULT")) return;
  const failed =
    value.stage === "CHECK_FAILED" || value.stage === "RISK_LOCKED";
  const recovered = [
    "EVALUATING",
    "WAITING_CANDLE",
    "DECISION",
    "ORDER_INTENT",
  ].includes(value.stage);
  try {
    const event = await tenant(tid, async (db) => {
      await db.query(
        "INSERT INTO bot_monitoring(bot_id,tenant_id,snapshot,last_success_at,price,price_at,error_snapshot,error_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() END,$5,$6,CASE WHEN $7 THEN $3::jsonb END,CASE WHEN $7 THEN now() END) ON CONFLICT(bot_id) DO UPDATE SET checked_at=now(),snapshot=EXCLUDED.snapshot,last_success_at=COALESCE(EXCLUDED.last_success_at,bot_monitoring.last_success_at),price=COALESCE(EXCLUDED.price,bot_monitoring.price),price_at=COALESCE(EXCLUDED.price_at,bot_monitoring.price_at),error_snapshot=CASE WHEN $8 THEN NULL ELSE COALESCE(EXCLUDED.error_snapshot,bot_monitoring.error_snapshot) END,error_at=CASE WHEN $8 THEN NULL ELSE COALESCE(EXCLUDED.error_at,bot_monitoring.error_at) END",
        [
          botId,
          tid,
          JSON.stringify(value),
          value.stage !== "CHECK_FAILED",
          Number.isFinite(value.price) && value.price! > 0 ? value.price : null,
          value.priceAt ? new Date(value.priceAt) : null,
          failed && !value.reasons.includes("BOT_NOT_ACTIVE"),
          recovered,
        ],
      );
      const last = (
        await db.query(
          "SELECT created_at,snapshot FROM bot_diagnostic_events WHERE tenant_id=$1 AND bot_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [tid, botId],
        )
      ).rows[0];
      const fingerprint = (snapshot: BotObservation) =>
        JSON.stringify([
          snapshot.stage,
          snapshot.reasons,
          snapshot.exchangeCode,
          snapshot.candleTime,
          snapshot.executionEnabled,
          snapshot.privateReady,
          snapshot.reconciled,
        ]);
      if (
        !last ||
        fingerprint(last.snapshot) !== fingerprint(value) ||
        Date.now() - last.created_at.getTime() >= 600000
      ) {
        await db.query(
          "INSERT INTO bot_diagnostic_events(tenant_id,bot_id,snapshot) VALUES($1,$2,$3)",
          [tid, botId, JSON.stringify(value)],
        );
        await db.query(
          "DELETE FROM bot_diagnostic_events WHERE tenant_id=$1 AND bot_id=$2 AND (created_at<now()-interval '14 days' OR id IN (SELECT id FROM bot_diagnostic_events WHERE tenant_id=$1 AND bot_id=$2 ORDER BY created_at DESC,id DESC OFFSET 10000))",
          [tid, botId],
        );
        return true;
      }
      return false;
    });
    if (event)
      console.info(
        JSON.stringify({
          event: "BOT_DIAGNOSTIC",
          tenantId: tid,
          botId,
          stage: value.stage,
          reasons: value.reasons,
          candleTime: value.candleTime,
          exchangeCode: value.exchangeCode,
        }),
      );
  } catch {
    console.error(
      JSON.stringify({ event: "BOT_MONITORING_WRITE_FAILED", botId }),
    );
  }
}
