import { z } from "zod";
import { pool } from "./db.ts";
import { encrypt, decrypt } from "../../../packages/core/src/index.ts";
import { configuredProvider } from "../../../packages/ai-providers/src/index.ts";
export const settingsSchema = z.strictObject({
  MAIL_MODE: z.enum(["disabled", "resend"]).optional(),
  MAIL_FROM: z
    .string()
    .max(254)
    .refine((v) => !/[\r\n]/.test(v))
    .optional(),
  RESEND_API_KEY: z.string().trim().max(512).optional(),
  AI_PROVIDER: z
    .enum(["disabled", "openai", "anthropic", "gemini", "deepseek"])
    .optional(),
  AI_MODEL: z.string().trim().max(128).optional(),
  AI_API_KEY: z.string().trim().max(2048).optional(),
  AI_MAX_CALLS_PER_DAY: z
    .string()
    .regex(/^\d{1,5}$/)
    .refine((v) => Number(v) <= 10000)
    .optional(),
  NEWS_ENABLED: z.enum(["true", "false"]).optional(),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .max(512)
    .regex(/^(?:\d+:[A-Za-z0-9_-]+)?$/)
    .optional(),
  BILLING_WEBHOOK_SECRET: z.string().max(512).optional(),
});
export const secretNames = [
  "RESEND_API_KEY",
  "AI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "BILLING_WEBHOOK_SECRET",
] as const;
export type InstallationSettings = z.infer<typeof settingsSchema>;
export const settingsContext = "platform-settings:v1";
export async function savedSettings(
  db: Pick<typeof pool, "query"> = pool,
): Promise<InstallationSettings> {
  const row = (
    await db.query(
      "SELECT encrypted_value FROM platform_settings WHERE singleton",
    )
  ).rows[0];
  return row
    ? settingsSchema.parse(
        decrypt(
          row.encrypted_value,
          process.env.APP_ENCRYPTION_KEY!,
          settingsContext,
        ),
      )
    : {};
}
export async function runtimeConfiguration(
  db: Pick<typeof pool, "query"> = pool,
): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, ...(await savedSettings(db)) };
}
export async function runtimeProvider(db: Pick<typeof pool, "query"> = pool) {
  return configuredProvider(await runtimeConfiguration(db));
}
export async function isOperator(userId: string) {
  return !!(
    await pool.query("SELECT 1 FROM platform_operators WHERE user_id=$1", [
      userId,
    ])
  ).rowCount;
}
export async function publicSetupStatus() {
  const state = (
    await pool.query(
      "SELECT NOT EXISTS(SELECT FROM users) AND NOT EXISTS(SELECT FROM platform_operators) AS fresh",
    )
  ).rows[0];
  const env = await runtimeConfiguration();
  return {
    needsSetup:
      state.fresh && process.env.INSTALLATION_SETUP_ENABLED === "true",
    registrationEnabled:
      (env.MAIL_MODE ??
        (env.NODE_ENV === "production" ? "disabled" : "development")) !==
      "disabled",
  };
}
export function publicSettings(env: NodeJS.ProcessEnv) {
  return {
    MAIL_MODE: env.MAIL_MODE ?? "disabled",
    MAIL_FROM: env.MAIL_FROM ?? "",
    AI_PROVIDER: env.AI_PROVIDER ?? "disabled",
    AI_MODEL: env.AI_MODEL ?? "",
    AI_MAX_CALLS_PER_DAY: env.AI_MAX_CALLS_PER_DAY ?? "100",
    NEWS_ENABLED: env.NEWS_ENABLED ?? "false",
    configured: Object.fromEntries(
      secretNames.map((name) => [name, !!env[name]]),
    ),
  };
}
export function sealSettings(value: InstallationSettings) {
  return encrypt(value, process.env.APP_ENCRYPTION_KEY!, settingsContext);
}
