CREATE TABLE custom_strategies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), family_id uuid NOT NULL,
 name text NOT NULL, version integer NOT NULL CHECK(version>0), rules jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,family_id,version)
);
ALTER TABLE custom_strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_strategies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_strategies USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE bots DROP CONSTRAINT bots_supported_strategy;
ALTER TABLE bots ADD CONSTRAINT bots_supported_strategy CHECK(strategy_version IN ('trend-v1.0','breakout-v1.0','dca-v1.0','grid-accumulation-v1.0','grid-accumulation-v1.1','custom-v1.0','ai-v1.0'));
ALTER TABLE bots ADD CONSTRAINT bots_timeframe CHECK(timeframe IN ('15','30','60'));
ALTER TABLE bots ADD COLUMN custom_strategy_id uuid;
ALTER TABLE bots ADD COLUMN ai_strategy_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE bots ADD CONSTRAINT bots_custom_strategy FOREIGN KEY(tenant_id,custom_strategy_id) REFERENCES custom_strategies(tenant_id,id);
ALTER TABLE bots ADD CONSTRAINT bots_custom_required CHECK((strategy_version='custom-v1.0')=(custom_strategy_id IS NOT NULL));
CREATE TABLE ai_strategy_decisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, bot_id uuid NOT NULL, candle_time bigint NOT NULL,
 provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL, input jsonb NOT NULL,
 result jsonb, status text NOT NULL CHECK(status IN ('VALID','FAILED')), error_code text,
 input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(bot_id,candle_time),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
ALTER TABLE ai_strategy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_strategy_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_strategy_decisions USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
