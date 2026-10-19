ALTER TABLE bots ADD COLUMN IF NOT EXISTS ai_mode text NOT NULL DEFAULT 'OFF' CHECK (ai_mode IN ('OFF','ADVISORY','FILTER'));
ALTER TABLE bots ADD COLUMN IF NOT EXISTS last_ai_news text;
CREATE TABLE ai_market_contexts (
 id text PRIMARY KEY, provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
 input jsonb NOT NULL, result jsonb, status text NOT NULL CHECK(status IN ('VALID','FAILED')),
 error_code text, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE ai_usage_daily (
 day date PRIMARY KEY, calls integer NOT NULL DEFAULT 0, input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0
);
CREATE TABLE ai_analyses (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), bot_id uuid NOT NULL,
 candle_time bigint NOT NULL, input_hash text NOT NULL, context_id text REFERENCES ai_market_contexts(id),
 mode text NOT NULL CHECK(mode IN ('ADVISORY','FILTER')), provider text NOT NULL, model text NOT NULL,
 prompt_version text NOT NULL, status text NOT NULL CHECK(status IN ('VALID','FAILED')), result jsonb, error_code text,
 comparison jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(bot_id,candle_time,input_hash,mode),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
ALTER TABLE signals ADD COLUMN ai_analysis_id uuid;
ALTER TABLE signals ADD CONSTRAINT signals_ai_analysis_tenant FOREIGN KEY(tenant_id,ai_analysis_id) REFERENCES ai_analyses(tenant_id,id);
CREATE TABLE news_articles (
 id text PRIMARY KEY, source text NOT NULL, title text NOT NULL, url text NOT NULL, published_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), analysis jsonb, analysis_status text NOT NULL DEFAULT 'PENDING',
 provider text, model text, error_code text, analyzed_at timestamptz
);
CREATE INDEX news_published_idx ON news_articles(published_at DESC);
CREATE INDEX ai_history_idx ON ai_analyses(tenant_id,created_at DESC);
ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_analyses USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
