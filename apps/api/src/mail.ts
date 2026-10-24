import { runtimeConfiguration } from "./installation.ts";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
export class MailDeliveryError extends Error {
  constructor() {
    super("EMAIL_DELIVERY_UNAVAILABLE");
  }
}
export function validateMailConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const mode =
    env.MAIL_MODE ??
    (env.NODE_ENV === "production" ? "disabled" : "development");
  if (!["development", "resend", "disabled"].includes(mode))
    throw Error("MAIL_MODE must be development, disabled or resend");
  if (env.NODE_ENV === "production" && mode === "development")
    throw Error("Production does not support the development outbox");
  if (
    mode === "resend" &&
    (!env.RESEND_API_KEY?.trim() ||
      !env.MAIL_FROM?.trim() ||
      /[\r\n]/.test(env.MAIL_FROM))
  )
    throw Error("Resend requires RESEND_API_KEY and MAIL_FROM");
}
export async function deliverAccountLink(
  to: string,
  kind: "verify" | "reset",
  url: string,
  env: NodeJS.ProcessEnv | undefined = undefined,
  transport: typeof fetch = fetch,
) {
  env ??= await runtimeConfiguration();
  validateMailConfiguration(env);
  if (
    (env.MAIL_MODE ??
      (env.NODE_ENV === "production" ? "disabled" : "development")) ===
    "disabled"
  )
    throw new MailDeliveryError();
  if ((env.MAIL_MODE ?? "development") === "resend") {
    try {
      const response = await transport("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [to],
          subject:
            kind === "verify"
              ? "Verify your Trader account"
              : "Reset your Trader password",
          text:
            (kind === "verify"
              ? "Verify your email address"
              : "Reset your password") +
            ":\n\n" +
            url +
            "\n\nThis link expires in 30 minutes. If you did not request it, ignore this email.",
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error();
      const body = (await response.json()) as any;
      if (typeof body?.id !== "string" || !body.id) throw Error();
      return;
    } catch {
      throw new MailDeliveryError();
    }
  }
  const outbox =
    env.NODE_ENV === "test" && env.TEST_MAIL_OUTBOX_PATH
      ? env.TEST_MAIL_OUTBOX_PATH
      : resolve(import.meta.dirname, "../../../.local/mail.jsonl");
  await mkdir(dirname(outbox), { recursive: true, mode: 0o700 });
  await appendFile(outbox, JSON.stringify({ to, kind, url }) + "\n", {
    mode: 0o600,
  });
}
export function validatePublicOrigin(env: NodeJS.ProcessEnv = process.env) {
  const value = env.APP_ORIGIN ?? "http://localhost:3000";
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password ||
    (env.NODE_ENV === "production" && url.protocol !== "https:")
  )
    throw Error(
      "APP_ORIGIN must be a single origin; production requires HTTPS and no trailing slash",
    );
  return value;
}
