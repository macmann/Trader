CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL,
 verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY, owner_id uuid UNIQUE NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, reauthenticated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_tokens (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS login_history (id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), succeeded boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS exchange_connections (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL,
 provider text NOT NULL DEFAULT 'BYBIT', environment text NOT NULL CHECK(environment IN ('TESTNET','LIVE')),
 credentials text NOT NULL, encryption_key_version int NOT NULL DEFAULT 1,
 status text NOT NULL, permissions jsonb NOT NULL, last_verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS bots (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), connection_id uuid NOT NULL,
 name text NOT NULL, symbol text NOT NULL DEFAULT 'BTCUSDT' CHECK(symbol='BTCUSDT'),
 timeframe text NOT NULL DEFAULT '15', strategy_version text NOT NULL DEFAULT 'trend-v1.0',
 status text NOT NULL DEFAULT 'STOPPED', config jsonb NOT NULL, last_candle bigint,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES exchange_connections(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS signals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), bot_id uuid NOT NULL,
 candle_time bigint NOT NULL, strategy_version text NOT NULL, data jsonb NOT NULL, decision jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bot_id,candle_time),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), bot_id uuid NOT NULL,
 signal_id uuid REFERENCES signals(id), client_id text UNIQUE NOT NULL, exchange_id text,
 side text NOT NULL, quantity numeric NOT NULL, state text NOT NULL, raw jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS positions (
 bot_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quantity numeric NOT NULL DEFAULT 0,
 cost numeric NOT NULL DEFAULT 0, realized_pnl numeric NOT NULL DEFAULT 0,
 fees numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS executions (
 id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), order_id uuid NOT NULL REFERENCES orders(id),
 quantity numeric NOT NULL, price numeric NOT NULL, fee numeric NOT NULL, executed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), action text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_controls (id boolean PRIMARY KEY DEFAULT true CHECK(id), execution_stopped boolean NOT NULL DEFAULT false);
INSERT INTO platform_controls(id) VALUES(true) ON CONFLICT DO NOTHING;
-- Application access uses explicit tenant predicates and composite foreign keys.
-- RLS is additionally applied to customer tables, with SET LOCAL inside each transaction.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['exchange_connections','bots','signals','orders','positions','executions','audit_logs'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'',true))',t);
 END IF;
 END LOOP;
END $$;
