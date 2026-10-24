# Minimal Coolify deployment

The default deployment includes PostgreSQL, web, worker, one-shot credential initialization and migrations. It needs **only two variables**:

```env
APP_ORIGIN=https://tradingbot.b-connect.site
APP_ENCRYPTION_KEY=<permanent 64-character hex key>
```

Generate the key once on a trusted machine with `openssl rand -hex 32`. Store it securely in Coolify and back it up separately. It encrypts integration and exchange credentials in PostgreSQL and must remain outside that database. Replacing it makes existing encrypted secrets unreadable. Database storage alone does not protect keys; encryption, operator authorization and server security do.

## Deploy

1. Point `tradingbot.b-connect.site` at your Coolify server.
2. Add `macmann/Trader`, branch `main`, with the **Docker Compose** build pack and Compose location `/compose.coolify.yaml`. Build context is the repository root.
3. Add the two variables above. Remove obsolete database URL/password and provider variables from this application's Coolify configuration. The default bundled Compose does not use them.
4. Assign `https://tradingbot.b-connect.site` to **web**, container port **3000**. Keep direct container access private. Coolify supplies HTTPS and the reverse proxy; the application trusts one immediate proxy hop.
5. Deploy. Credential initialization completes, PostgreSQL becomes healthy, migrations complete, then web and worker start. The two one-shot services exiting successfully is expected.

A small test deployment should have about 2 CPU cores, 4 GB RAM available for builds/application/database, and persistent disk. Redis is not needed. PostgreSQL has no published host port. Web/worker run as non-root with read-only roots and temporary writable `/tmp`.

Random internal database passwords are generated once and preserved in separate secret volumes. Web/worker receive only the restricted application's credential, not the administrator password. Migrations alone receive both credentials and provision the restricted role. The database administrator credential is also used by the PostgreSQL image for initialization. Generated secrets never appear in initialization logs or Compose environment variables.

The encryption key remains in the Coolify secret environment configuration. Do not replace generated credential files to rotate passwords: passwords in PostgreSQL must be changed deliberately and synchronized with those files during a maintenance window.

## Create the administrator

After web becomes healthy, open its **Terminal** in Coolify and run:

```sh
cat /run/app-secrets/setup-token
```

This is an intentional server-administrator operation. Copy the token privately into the first-run setup form at your HTTPS domain, choose your email and a password of at least 12 characters, then sign in. Do not put the token in a URL, chat, screenshot or log.

Setup requires the high-entropy token and a fresh database; it does not promote whoever first visits or registers. Concurrent claims are serialized, and only one can succeed. The token's database hash is consumed on success. The initial platform administrator is explicitly verified by this server-authorized process, so email delivery is unnecessary for installation. All later public users still require verification. Workspace owners/admins do not automatically become platform administrators.

The original token file may remain in its protected volume for repeatable deployment, but cannot claim setup again. If the database already has users and no platform administrator, setup refuses to create another account. An existing deployment needs an intentional operator assignment by the database administrator after confirming the account identity; do not delete accounts or reset setup to work around this guard.

## Configure integrations later

Open **Admin Settings** after signing in as the platform administrator:

- **Email:** choose Resend, supply a sender on your verified domain and a sending API key. Public registration becomes available once configured. Real delivery/DNS must be verified by the operator; saving configuration does not prove delivery works.
- **AI:** choose provider/model, add its key and set the daily call budget. AI is disabled initially. News analysis is optional and initially off.
- **Telegram:** add the bot token here, then configure each workspace's chat/preferences under Platform notifications.
- **Billing webhook:** optionally configure the signed gateway secret. This does not turn on payment collection.

Secrets are encrypted with AES-256-GCM and context binding. The settings page returns only configuration indicators for keys and tokens. Empty replacement inputs preserve saved secrets; explicit clear checkboxes remove them. Each save requires the platform administrator's current password, session authentication, CSRF and origin checks. Audit records contain changed field names, never secret values. Settings are installation-wide and can be used by private server workers; they are not tenant-owned API keys. Customer exchange credentials remain scoped to their own tenants.

New requests and worker cycles read current settings. In-flight provider requests may finish with the configuration they already loaded. Disabling email closes public registration; reset requests still return generic responses but no email can be sent. Production never uses the development mail outbox. Keep a working administrator session and password until email recovery is configured. No email/AI/Telegram key is needed to boot or use paper replay.

## Verify

- Confirm web/worker become healthy and `/api/health` reports `status: ok`, `liveTrading: false`.
- Complete setup, sign in, and check Admin Settings is restricted to the installation administrator.
- Try **Platform → Research and Paper trading** with uploaded candles; no exchange credentials are required. Automatic paper feeds require permitted public OKX access.
- After configuring Resend, register a second account, verify its email, test reset delivery and check tenant isolation. Resend needs outbound `api.resend.com`.
- Check worker logs show execution and live trading disabled. Health does not certify exchange connectivity, strategy profitability or order protection.

For later read-only Bybit Testnet acceptance, connect dedicated Testnet credentials through the app and run in the web terminal:

```sh
node --use-env-proxy --import tsx scripts/container-entrypoint.ts preflight
```

This reports readiness, never submits orders, and cannot certify authenticated trading acceptance. Bybit Testnet needs permitted access to `api-testnet.bybit.com` and `stream-testnet.bybit.com`; respect exchange regional restrictions.

## Persistence, updates and recovery

Back up the `postgres-data`, `admin-secrets` and `app-secrets` volumes and the encryption key securely, with restricted access. Test restoration of both database and secrets. Never use `docker compose down -v` on a deployment you want to keep. Do not regenerate credential volumes while retaining an initialized database: PostgreSQL keeps the old passwords. Application redeployment preserves all three volumes and does not rotate credentials or reopen setup.

Take a database backup before updates. Migration checksums reject edited history, and migrations serialize initialization. Application rollback does not roll back the database. Failed initialization/migration prevents app startup; inspect sanitized service logs without printing credentials.

Existing external/shared-database deployments are not automatically migrated. Back up the old database and encryption key, restore into the bundled PostgreSQL database with appropriate ownership/roles and intact migration history, then deliberately assign a platform operator to the verified account using a database-administrator connection. Never switch to an empty bundled database and assume it contains your old accounts. Keep the old deployment available until restoration is verified.

For administrator account recovery without email, use an authenticated database-administrator maintenance procedure to reset the specific account's Argon2id password hash and revoke its sessions. There is no public recovery bypass or permanent setup backdoor. Re-enabling first-run setup on a populated installation is intentionally unsupported.

Builds use the existing non-root Node 24 image. Normal Coolify builds need no custom CA; managed build proxies can mount the optional BuildKit `proxy_ca` secret while preserving TLS verification. Local checks do not validate your real Coolify routing, DNS, email delivery or exchange connectivity.
