# Deploy on Coolify

This deploys the web dashboard/API, trading/paper worker and private PostgreSQL database. Trading submission and Live are fixed OFF in the supplied Compose file. The application can run in production mode for accounts, research, paper trading and Testnet connection checks; this is not a declaration of production financial-execution readiness.

## 1. Prepare a domain and email sender

Point a domain such as `trader.example.com` at your Coolify server. Use HTTPS so production session cookies work. Verify a sending domain in Resend, create a sending API key, and choose a sender on that domain (for example `Trader <accounts@example.com>`). Verification/reset emails use this transport; production never writes links to the development mail outbox. Real Resend/DNS delivery needs your credentials and is not verified by fixture tests.

A small test deployment should have roughly 2 CPU cores and 4 GB RAM available for image builds, PostgreSQL and the application. PostgreSQL needs persistent disk. The current code uses PostgreSQL for sessions, caching and locking; Redis is not required by this deployment.

## 2. Add the repository

In Coolify, create an application from `macmann/Trader`, branch `main`, using the **Docker Compose** build pack. Set the Compose location to:

```text
/compose.coolify.yaml
```

The build context is the repository root and the Dockerfile is `/Dockerfile`. Assign your HTTPS domain to the **web** service on container port **3000**. Only web should receive a public domain. Do not publish PostgreSQL, worker or migrate ports. Coolify supplies the reverse proxy/TLS certificate; the app trusts one immediate proxy hop. Direct public access to the container port should remain blocked.

## 3. Configure environment variables

Set these in Coolify before deployment; use secret values rather than committing a `.env` file:

| Variable                | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `APP_ORIGIN`            | Exact public origin, e.g. `https://trader.example.com`; no trailing slash/path |
| `APP_ENCRYPTION_KEY`    | Permanent random 64-character hex key                                          |
| `APP_DATABASE_PASSWORD` | Separate strong password, at least 32 characters, for restricted `trader_app`  |
| `POSTGRES_PASSWORD`     | Separate strong PostgreSQL administrator password                              |
| `MAIL_FROM`             | Sender on your verified Resend domain                                          |
| `RESEND_API_KEY`        | Your Resend sending key                                                        |

Generate each of the three long secrets independently on a trusted machine:

```sh
openssl rand -hex 32
```

Back up `APP_ENCRYPTION_KEY` securely alongside encrypted database backups. Replacing it makes previously stored exchange credentials unreadable. Keep the administrator and application database passwords different. Values are passed as PostgreSQL environment fields rather than assembled into URLs, so URL escaping is unnecessary.

Optional variables are `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_CALLS_PER_DAY`, `NEWS_ENABLED`, `TELEGRAM_BOT_TOKEN`, and `BILLING_WEBHOOK_SECRET`. Leave AI disabled and news off initially. The example at `infra/coolify.env.example` contains names only; never enter actual secrets there in Git.

`NODE_ENV=production`, `MAIL_MODE=resend`, the internal database host/roles, and both disabled trading flags are set by Compose. Changing unrelated Coolify environment flags does not override the fixed trading switches. Do not edit those switches before the Testnet/native-protection and earlier release gates are satisfied.

## 4. Deploy

Coolify builds a non-root Node 24 image and starts services in this order:

1. PostgreSQL becomes healthy on the private Compose network.
2. `migrate` runs once, applies the idempotent schema and checksum-verified migrations, configures the restricted runtime role/password and refreshes grants.
3. Web and worker start after successful migration.

`migrate` exiting successfully is expected. A failed migration prevents dependent services from starting; inspect its sanitized error and database/Coolify logs. Do not delete the database or modify applied migration files to hide a checksum failure. The web/worker do not receive the database administrator password or admin connection URL.

Web health checks read `/api/health` and verify PostgreSQL access. Worker health checks require recent loop progress; they do not certify exchange connectivity, strategy performance or order protection. Application crashes restart automatically; an unhealthy-but-running container may require Coolify monitoring/operator action. Both application containers use a read-only root filesystem and a temporary writable `/tmp` for the TS loader and worker heartbeat. A persistent named volume stores PostgreSQL data.

No repository `.env`, Git metadata, local mail, test reports or encryption secrets are copied into the image. Build tools are removed from the runtime; `tsx` remains as a production dependency because the services execute TypeScript directly. Ordinary Coolify builds require no custom CA. Managed build proxies can supply the optional BuildKit `proxy_ca` secret while retaining TLS verification; that CA is not embedded in the image.

## 5. Verify the deployment

- Visit your HTTPS domain and register. Open the verification email, sign in, and verify logout/login and password reset.
- Open Platform → Research and Paper trading. Uploaded-candle replay requires no exchange credentials. Automatic paper feeds require outbound public OKX access.
- Confirm `/api/health` returns `status: ok` and `liveTrading: false`; protected APIs must require login.
- Confirm web/worker are healthy and worker startup logs show `executionEnabled: false` and `liveEnabled: false`.
- Add a second verified user to an organization to test workspace roles and tenant isolation.

If registration succeeded but mail delivery failed, sign in and resend verification after fixing the sender/key/network. Failed deliveries revoke the corresponding link. Password-reset responses stay generic so a mail outage does not disclose whether an email is registered. No API keys or verification/reset links should appear in logs.

For later read-only exchange checks, connect dedicated Testnet accounts through the UI and run this in the web service terminal (its injected environment is already present):

```sh
node --use-env-proxy --import tsx scripts/testnet-preflight.ts
```

The report is printed. On the read-only deployment it is also written to temporary `/tmp`; copy sanitized results if needed before container replacement. Bybit Testnet needs permitted outbound access to `api-testnet.bybit.com` and `stream-testnet.bybit.com`; OKX, AI and Telegram use the hosts documented for those features. Resend requires `api.resend.com`. Your server location must be allowed by the exchange. Never bypass regional restrictions or paste exchange secrets into chat.

## Backups, updates and credentials

Configure PostgreSQL backups to separate storage and test restoration. Preserve the named volume across redeployments; deleting it deletes accounts, research, bots and ledgers. Back up secrets separately, with access controls. Never run `docker compose down -v` on a deployment you intend to retain.

Take a database backup before updates. Migrations serialize deployment initialization and refuse changed checksums; repeated initialization preserves existing rows. Application rollback does not roll back the database, so check schema compatibility and use a maintenance window for breaking changes.

The deployment migrator updates the `trader_app` password from `APP_DATABASE_PASSWORD` when it runs. Redeploy all runtime services together after rotating it. Changing `POSTGRES_PASSWORD` in an existing deployment does not automatically rotate the password inside an initialized PostgreSQL volume: rotate the actual database administrator password deliberately, then update Coolify and redeploy. Do not substitute the local development passwords.

## Validation performed in this repository

The deployment was built and booted against a fresh isolated PostgreSQL container. Web/worker became healthy after migration. The runtime role enforces RLS, admin credentials are absent from web, production login/session cookies include Secure/HttpOnly/SameSite, and CSRF checks reject missing tokens. Re-running migration succeeds. Unit/integration tests exercise delivery contracts with HTTP fixtures, failure redaction and authentication recovery. These are local Docker checks; deploying to your Coolify instance, DNS/TLS and real email/exchange delivery remain operator checks.
