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
    await tenant(tid, (db) =>
      db.query(
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
      ),
    );
  } catch {
    console.error(
      JSON.stringify({ event: "BOT_MONITORING_WRITE_FAILED", botId }),
    );
  }
}
