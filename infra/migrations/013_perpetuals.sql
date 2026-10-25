ALTER TABLE bots ADD COLUMN market_type text NOT NULL DEFAULT 'SPOT' CHECK(market_type IN ('SPOT','LINEAR'));
ALTER TABLE bots ADD COLUMN futures_reconciled_at timestamptz;
ALTER TABLE bots ADD COLUMN futures_started_at timestamptz;
ALTER TABLE bots ADD CONSTRAINT futures_ai_only CHECK(market_type='SPOT' OR strategy_version='ai-v1.0');
CREATE UNIQUE INDEX one_bot_per_contract ON bots(tenant_id,connection_id,symbol) WHERE market_type='LINEAR';
ALTER TABLE orders ADD COLUMN market_type text NOT NULL DEFAULT 'SPOT' CHECK(market_type IN ('SPOT','LINEAR'));
ALTER TABLE orders ADD COLUMN purpose text NOT NULL DEFAULT 'ENTRY' CHECK(purpose IN ('ENTRY','EXIT'));
ALTER TABLE orders ADD COLUMN position_direction text NOT NULL DEFAULT 'LONG' CHECK(position_direction IN ('LONG','SHORT'));
UPDATE orders SET purpose='EXIT' WHERE side='Sell';
ALTER TABLE positions ADD COLUMN position_direction text NOT NULL DEFAULT 'LONG' CHECK(position_direction IN ('LONG','SHORT'));
ALTER TABLE positions ADD COLUMN funding_total numeric NOT NULL DEFAULT 0;
CREATE TABLE futures_funding (
 tenant_id uuid NOT NULL, bot_id uuid NOT NULL, event_id text NOT NULL, amount numeric NOT NULL, occurred_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,bot_id,event_id), FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE futures_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE futures_funding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON futures_funding USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE FUNCTION normalize_spot_order_purpose() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.market_type='SPOT' THEN NEW.purpose=CASE WHEN NEW.side='Buy' THEN 'ENTRY' ELSE 'EXIT' END; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER normalize_spot_order_purpose BEFORE INSERT OR UPDATE OF side,market_type,purpose ON orders FOR EACH ROW EXECUTE FUNCTION normalize_spot_order_purpose();
ALTER TABLE orders ADD CONSTRAINT futures_order_side CHECK(market_type='SPOT' OR side=CASE WHEN (purpose='ENTRY')=(position_direction='LONG') THEN 'Buy' ELSE 'Sell' END);
ALTER TABLE orders ADD CONSTRAINT futures_market_only CHECK(market_type='SPOT' OR order_type='MARKET');
CREATE INDEX futures_funding_time ON futures_funding(tenant_id,bot_id,occurred_at DESC);
