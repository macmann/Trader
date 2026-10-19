ALTER TABLE orders ADD CONSTRAINT orders_tenant_identity UNIQUE(tenant_id,id);
ALTER TABLE orders ADD COLUMN strategy_version text;
UPDATE orders o SET strategy_version=COALESCE((SELECT strategy_version FROM signals WHERE id=o.signal_id),b.strategy_version) FROM bots b WHERE b.id=o.bot_id;
ALTER TABLE orders ADD COLUMN grid_level integer;
ALTER TABLE orders ADD COLUMN strategy_cycle integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN time_in_force text NOT NULL DEFAULT 'GTC';
ALTER TABLE orders ADD COLUMN expires_at timestamptz;
ALTER TABLE orders ADD COLUMN cancel_requested_at timestamptz;
ALTER TABLE orders ADD COLUMN submitted_at timestamptz;
CREATE UNIQUE INDEX unique_grid_rung_intent ON orders(bot_id,strategy_cycle,grid_level) WHERE grid_level IS NOT NULL AND state NOT IN ('Cancelled','Rejected','Deactivated','CANCELLED','REJECTED');
ALTER TABLE positions ADD COLUMN entry_fees numeric NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN cycle_net numeric NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN strategy_cycle integer NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN peak_equity numeric NOT NULL DEFAULT 0;
ALTER TABLE executions DROP CONSTRAINT executions_pkey;
ALTER TABLE executions ADD PRIMARY KEY(tenant_id,id);
ALTER TABLE executions ADD CONSTRAINT executions_tenant_order FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id);
ALTER TABLE executions ADD COLUMN fee_currency text NOT NULL DEFAULT 'USDT';
ALTER TABLE executions ADD COLUMN fee_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN net_quantity numeric NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN realized_gross numeric NOT NULL DEFAULT 0;
ALTER TABLE executions ADD COLUMN realized_net numeric NOT NULL DEFAULT 0;
ALTER TABLE exchange_connections ADD COLUMN reconciled_at timestamptz;
CREATE TABLE order_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), order_id uuid NOT NULL,
 event_key text NOT NULL, state text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,order_id,event_key), FOREIGN KEY(tenant_id,order_id) REFERENCES orders(tenant_id,id)
);
CREATE TABLE trade_cycles (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, bot_id uuid NOT NULL, strategy_version text NOT NULL,
 net_pnl numeric NOT NULL, closing_execution_id text NOT NULL, closed_at timestamptz NOT NULL,
 UNIQUE(tenant_id,closing_execution_id), FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id),
 FOREIGN KEY(tenant_id,closing_execution_id) REFERENCES executions(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['order_events','trade_cycles'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))',t);
 END LOOP;
END $$;

ALTER TABLE exchange_connections ADD COLUMN ledger_version integer NOT NULL DEFAULT 2;
UPDATE exchange_connections c SET ledger_version=1 WHERE EXISTS(SELECT 1 FROM bots b JOIN orders o ON o.bot_id=b.id JOIN executions e ON e.order_id=o.id WHERE b.connection_id=c.id);
UPDATE bots b SET status='RISK_LOCKED' FROM exchange_connections c WHERE b.connection_id=c.id AND c.ledger_version=1;

ALTER TABLE positions ADD COLUMN last_exit_price numeric NOT NULL DEFAULT 0;
ALTER TABLE bots DROP CONSTRAINT bots_supported_strategy;
ALTER TABLE bots ADD CONSTRAINT bots_supported_strategy CHECK(strategy_version IN ('trend-v1.0','breakout-v1.0','dca-v1.0','grid-accumulation-v1.0','grid-accumulation-v1.1'));
