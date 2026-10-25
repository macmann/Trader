CREATE TABLE bot_diagnostic_events (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, bot_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL,
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE bot_diagnostic_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_diagnostic_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_diagnostic_events USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE INDEX bot_diagnostic_events_history ON bot_diagnostic_events(tenant_id,bot_id,created_at DESC,id DESC);
