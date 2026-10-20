# Deploy on Coolify with shared PostgreSQL

The production Compose file runs only **migrate**, **web**, and **worker**. It connects to your existing PostgreSQL server; it creates no database container, database volume, database, login, or password. Both exchange execution and live trading remain disabled. Research, paper replay, accounts and dashboards can be tested first.

## Prepare PostgreSQL

Ask your database administrator to create a **dedicated database** for Trader on the shared PostgreSQL server, with two dedicated login roles:

- A migration role that owns the database and application objects and can create tables, functions and triggers in its `public` schema.
- A runtime role with `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. It must not own application tables, inherit privileged roles, or be a member of the migration role.

The runtime role must be allowed to connect to the dedicated database. The migration job grants its table/sequence permissions, including append-only audit restrictions; it never creates or changes cluster roles or passwords. Do not point it at a database containing another application's tables: schema migrations and grants operate on `public` in the configured database. The PostgreSQL server itself can be shared.

For example, a database administrator can provision the following, using separately generated passwords supplied securely (replace the placeholders; do not commit them):

```sql
CREATE ROLE trader_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<migration password>';
CREATE ROLE trader_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '<runtime password>';
CREATE DATABASE trader OWNER trader_migrator;
REVOKE CONNECT ON DATABASE trader FROM PUBLIC;
GRANT CONNECT ON DATABASE trader TO trader_migrator, trader_app;
-- Connect to the new trader database before executing these statements:
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO trader_migrator;
```

Use PostgreSQL 17 or a compatible supported version. Fresh installs support a non-superuser migration owner. Moving an existing installation requires a tested database restore with object ownership assigned to the migration role and the complete migration history preserved. Do not create an empty database as a substitute for migrating existing accounts.

## Configure Coolify

Create an application from `macmann/Trader`, branch `main`, with the **Docker Compose** build pack and Compose location `/compose.coolify.yaml`. Build context is the repository root. Assign your HTTPS domain to **web**, port **3000**. Worker and migrate need no public domain or port. Coolify provides the reverse proxy and HTTPS; the application trusts one immediate proxy hop.

The database hostname must be reachable **from all three containers**. `localhost` inside a container refers to that container. For a shared PostgreSQL resource in Coolify, enable the appropriate predefined/shared Docker network in Coolify and use the database's network alias and internal port. Verify the database and all application services join that network. For a separate server, use its reachable private DNS/IP and firewall rules allowing the Coolify server. No database service is added to this Compose file.

Set these environment variables in Coolify (see `infra/coolify.env.example`):

| Variable                      | Value                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PGHOST`                      | Reachable hostname of your existing PostgreSQL server                                                  |
| `PGPORT`                      | PostgreSQL port; defaults to `5432`                                                                    |
| `PGDATABASE`                  | Dedicated Trader database name                                                                         |
| `PGSSLMODE`                   | Defaults to `verify-full`; use `disable` only for a trusted private network when PostgreSQL has no TLS |
| `APP_DATABASE_USER`           | Pre-created restricted runtime login                                                                   |
| `APP_DATABASE_PASSWORD`       | Its existing password, at least 32 characters                                                          |
| `MIGRATION_DATABASE_USER`     | Separate database/schema owner login                                                                   |
| `MIGRATION_DATABASE_PASSWORD` | Its existing password                                                                                  |
| `APP_ORIGIN`                  | Exact HTTPS origin, e.g. `https://trader.example.com`, without trailing slash/path                     |
| `APP_ENCRYPTION_KEY`          | Permanent random 64-character hex encryption key                                                       |
| `MAIL_FROM`                   | Sender on your verified Resend domain                                                                  |
| `RESEND_API_KEY`              | Resend sending key                                                                                     |

Generate a new encryption key with `openssl rand -hex 32`, and back it up securely. Replacing it makes stored exchange credentials unreadable. Database passwords are existing server credentials, passed as individual fields, so URL escaping is unnecessary. The application does not rotate them on deployment. Database migration credentials are supplied only to the migration container.

TLS verifies the database certificate and hostname. For a private certificate authority, mount its PEM file read-only into all three services using Coolify configuration and set `NODE_EXTRA_CA_CERTS` to that container path on each service. Do not disable certificate verification to work around an untrusted certificate.

Verify a sending domain in Resend before registering users. Optional settings are `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_MAX_CALLS_PER_DAY`, `NEWS_ENABLED`, `TELEGRAM_BOT_TOKEN`, and `BILLING_WEBHOOK_SECRET`. Start with AI disabled and news off. `NODE_ENV=production`, `MAIL_MODE=resend`, and both disabled trading flags are fixed in Compose. Redis is not required.

## Deploy and verify

Coolify builds the non-root Node 24 image. The migration job connects to the shared database, applies the schema and checksum-verified migrations, and refreshes runtime grants. Web and worker start only after it exits successfully. There is no database-container health dependency; the shared server must already be available. A failed migration blocks startup: check its sanitized error and database logs without deleting data or modifying applied migration files.

Web health checks verify `/api/health` and database access. Worker health checks require recent loop progress. Application crashes restart automatically; an unhealthy running container may need operator action. Containers use read-only root filesystems and writable temporary `/tmp`. No database data is stored in application containers. The image excludes repository secrets, `.env`, local mail and Git metadata.

After deployment:

- Confirm web/worker become healthy and `/api/health` reports `status: ok` and `liveTrading: false`.
- Register, verify email, sign in, and exercise password reset over HTTPS. Production uses Resend; fixture tests do not verify your DNS or real email delivery.
- Open Platform → Research and Paper trading. Uploaded-candle replay needs no exchange credentials. Automatic paper feeds require public OKX access.
- Add a second verified user and check workspace roles and tenant isolation.
- Check worker logs show `executionEnabled: false` and `liveEnabled: false`.

If verification delivery fails, fix sender/key/network, then sign in and resend verification. Password-reset responses remain generic. Never put API keys or verification links in logs or chat.

For later read-only exchange checks, connect dedicated Testnet accounts through the UI, then run in the web terminal:

```sh
node --use-env-proxy --import tsx scripts/testnet-preflight.ts
```

Reports are written to temporary `/tmp`. Bybit Testnet needs permitted outbound access to `api-testnet.bybit.com` and `stream-testnet.bybit.com`; Resend needs `api.resend.com`. Exchange regional restrictions must be respected.

## Backups and updates

Manage persistence and backups on the shared PostgreSQL service, separately from the Coolify application. Back up the dedicated Trader database and encryption key securely, and test restoration. Deleting/redeploying application containers does not delete the external database.

Take a backup before updates. Migrations serialize initialization and validate checksums; application rollback does not roll back the database. Rotate database passwords on the shared server, update the matching Coolify secret and redeploy affected services together. The deployment does not alter other databases or role passwords.

Local verification covers migration repeatability, restricted roles, shared-server setup, and application tests. Your Coolify networking, production database TLS, DNS and actual email/exchange access still need deployment checks.
