CREATE TABLE bot_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id), bot_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), stopped_at timestamptz, stop_reason text,
 origin text NOT NULL DEFAULT 'START', UNIQUE(tenant_id,bot_id,id),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX one_open_bot_run ON bot_runs(bot_id) WHERE stopped_at IS NULL;
-- The timestamp marks monitoring adoption, not the original start of a legacy bot.
DO $$ DECLARE w record; previous_tenant text:=current_setting('app.tenant_id',true); BEGIN
 FOR w IN SELECT id FROM workspaces LOOP
  PERFORM set_config('app.tenant_id',w.id::text,true);
  INSERT INTO bot_runs(id,tenant_id,bot_id,origin) SELECT gen_random_uuid(),tenant_id,id,'MONITORING_ADOPTED' FROM bots WHERE tenant_id=w.id AND status IN ('STARTING','RUNNING','PAUSED','RISK_LOCKED');
 END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(previous_tenant,''),true);
END $$;
ALTER TABLE orders ADD COLUMN run_id uuid;
ALTER TABLE orders ADD CONSTRAINT orders_run_scope FOREIGN KEY(tenant_id,bot_id,run_id) REFERENCES bot_runs(tenant_id,bot_id,id);
ALTER TABLE signals ADD COLUMN run_id uuid;
ALTER TABLE signals ADD CONSTRAINT signals_run_scope FOREIGN KEY(tenant_id,bot_id,run_id) REFERENCES bot_runs(tenant_id,bot_id,id);
CREATE FUNCTION assign_bot_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.run_id IS NULL THEN
  SELECT id INTO NEW.run_id FROM bot_runs WHERE tenant_id=NEW.tenant_id AND bot_id=NEW.bot_id AND stopped_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_bot_run BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION assign_bot_run();
CREATE TRIGGER signal_bot_run BEFORE INSERT ON signals FOR EACH ROW EXECUTE FUNCTION assign_bot_run();
CREATE TABLE bot_monitoring (
 bot_id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 checked_at timestamptz NOT NULL DEFAULT now(), last_success_at timestamptz,
 snapshot jsonb NOT NULL DEFAULT '{}', price numeric, price_at timestamptz, error_snapshot jsonb, error_at timestamptz,
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bot_runs','bot_monitoring'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))',t);
 END LOOP;
END $$;
CREATE INDEX bot_orders_history ON orders(tenant_id,bot_id,created_at DESC);
CREATE INDEX bot_signals_history ON signals(tenant_id,bot_id,created_at DESC);
