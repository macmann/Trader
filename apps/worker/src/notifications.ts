import { runtimeConfiguration } from "../../api/src/installation.ts";
import { pool, tenant } from "../../api/src/db.ts";
export async function notificationCycle(
  transport: typeof fetch = fetch,
  token?: string,
) {
  token ??= (await runtimeConfiguration()).TELEGRAM_BOT_TOKEN;
  if (!token) return;
  for (const w of (await pool.query("SELECT id FROM workspaces")).rows) {
    const item = await tenant(w.id, async (db) => {
      // An interrupted send is uncertain; never automatically retry a possibly delivered message.
      await db.query(
        "UPDATE notifications SET telegram_state='FAILED' WHERE tenant_id=$1 AND telegram_state='SENDING' AND created_at<now()-interval '10 minutes'",
        [w.id],
      );
      const s = (
        await db.query(
          "SELECT * FROM notification_settings WHERE tenant_id=$1 AND enabled=true",
          [w.id],
        )
      ).rows[0];
      if (!s) return null;
      const n = (
        await db.query(
          "SELECT id,title FROM notifications WHERE tenant_id=$1 AND telegram_state='PENDING' AND created_at>now()-interval '1 hour' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
          [w.id],
        )
      ).rows[0];
      if (!n) return null;
      await db.query(
        "UPDATE notifications SET telegram_state='SENDING' WHERE tenant_id=$1 AND id=$2",
        [w.id, n.id],
      );
      return { ...n, chatId: s.telegram_chat_id };
    });
    if (!item) continue;
    let state = "FAILED";
    try {
      const r = await transport(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: item.chatId,
            text: "Trader workspace alert: " + item.title.slice(0, 200),
            disable_notification: false,
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (r.ok && ((await r.json()) as any).ok === true) state = "SENT";
    } catch {}
    await tenant(w.id, async (db) => {
      await db.query(
        "UPDATE notifications SET telegram_state=$1 WHERE tenant_id=$2 AND id=$3",
        [state, w.id, item.id],
      );
    });
  }
}
