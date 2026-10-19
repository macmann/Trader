ALTER TABLE bots DROP CONSTRAINT bots_symbol_check;
ALTER TABLE bots ADD CONSTRAINT bots_supported_symbol CHECK(symbol IN ('BTCUSDT','ETHUSDT','SOLUSDT'));
ALTER TABLE bots ADD CONSTRAINT bots_supported_strategy CHECK(strategy_version IN ('trend-v1.0','breakout-v1.0','dca-v1.0','grid-accumulation-v1.0'));
ALTER TABLE bots ADD COLUMN advanced_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE positions ADD COLUMN high_watermark numeric NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN last_entry_price numeric NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN last_entry_at timestamptz;
ALTER TABLE positions ADD COLUMN entry_count integer NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN grid_levels_filled jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orders ADD COLUMN symbol text;
UPDATE orders o SET symbol=b.symbol FROM bots b WHERE b.id=o.bot_id;
ALTER TABLE orders ALTER COLUMN symbol SET NOT NULL;
ALTER TABLE orders ALTER COLUMN symbol SET DEFAULT 'BTCUSDT';
ALTER TABLE orders ADD COLUMN order_type text NOT NULL DEFAULT 'MARKET';
ALTER TABLE orders ADD COLUMN limit_price numeric;
ALTER TABLE orders ADD COLUMN requested_notional numeric CHECK(requested_notional>=0);
CREATE TABLE portfolio_limits (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id), config jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE portfolio_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portfolio_limits USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE INDEX portfolio_orders_idx ON orders(tenant_id,bot_id,state);

ALTER TABLE ai_analyses ADD COLUMN symbol text NOT NULL DEFAULT 'BTCUSDT';
