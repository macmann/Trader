ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_id_key;
ALTER TABLE workspaces ADD COLUMN name text NOT NULL DEFAULT 'My workspace';
ALTER TABLE workspaces ADD COLUMN kind text NOT NULL DEFAULT 'PERSONAL' CHECK(kind IN ('PERSONAL','ORGANIZATION'));
CREATE UNIQUE INDEX personal_workspace_owner ON workspaces(owner_id) WHERE kind='PERSONAL';
ALTER TABLE sessions ADD COLUMN active_tenant_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
CREATE TABLE workspace_members (
 tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('OWNER','ADMIN','TRADER','VIEWER')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE subscriptions (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 plan text NOT NULL DEFAULT 'FREE' CHECK(plan IN ('FREE','BASIC','PRO')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAST_DUE','CANCELLED')),
 period_end timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_members(tenant_id,user_id,role) SELECT id,owner_id,'OWNER' FROM workspaces;
INSERT INTO subscriptions(tenant_id,plan) SELECT id,'PRO' FROM workspaces;
CREATE FUNCTION initialize_workspace() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 INSERT INTO workspace_members(tenant_id,user_id,role) VALUES(NEW.id,NEW.owner_id,'OWNER');
 INSERT INTO subscriptions(tenant_id) VALUES(NEW.id);
 RETURN NEW; END $$;
CREATE TRIGGER initialize_workspace AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION initialize_workspace();
CREATE TABLE billing_events(id text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE usage_records (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 metric text NOT NULL, units integer NOT NULL CHECK(units>0), reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,metric,reference)
);
CREATE TABLE research_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('BACKTEST','WALK_FORWARD')), symbol text NOT NULL,
 strategy_version text NOT NULL, config jsonb NOT NULL, advanced_config jsonb NOT NULL,
 settings jsonb NOT NULL, dataset_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE paper_sessions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL, symbol text NOT NULL, strategy_version text NOT NULL,
 config jsonb NOT NULL, advanced_config jsonb NOT NULL, settings jsonb NOT NULL,
 candles jsonb NOT NULL DEFAULT '[]', result jsonb NOT NULL, revision integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','STOPPED')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE strategy_listings (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL, description text NOT NULL,
 status text NOT NULL DEFAULT 'PUBLISHED' CHECK(status IN ('PUBLISHED','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE marketplace_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, listing_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), symbol text NOT NULL,
 strategy_version text NOT NULL, config jsonb NOT NULL, advanced_config jsonb NOT NULL,
 risk_classification text NOT NULL CHECK(risk_classification IN ('HIGH','VERY_HIGH')),
 research_run_id uuid NOT NULL, historical_results jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(listing_id,version), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,listing_id) REFERENCES strategy_listings(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,research_run_id) REFERENCES research_runs(tenant_id,id)
);
CREATE TABLE strategy_subscriptions (
 tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES marketplace_versions(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version_id)
);
ALTER TABLE bots ADD COLUMN marketplace_version_id uuid REFERENCES marketplace_versions(id);
CREATE TABLE notifications (
 id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 event_key text NOT NULL, title text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 telegram_state text NOT NULL DEFAULT 'PENDING' CHECK(telegram_state IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
 UNIQUE(tenant_id,event_key)
);
CREATE TABLE notification_settings (
 tenant_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, telegram_chat_id text,
 enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION notify_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO notifications(tenant_id,event_key,title) VALUES(NEW.tenant_id,'audit:'||NEW.id,replace(NEW.action,'_',' ')) ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER notify_audit AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION notify_audit();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['workspace_members','subscriptions','usage_records','research_runs','paper_sessions','strategy_subscriptions','notifications','notification_settings','billing_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id::text=current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''app.tenant_id'',true))',t);
 END LOOP;
END $$;
CREATE POLICY self_membership ON workspace_members FOR SELECT USING(user_id::text=current_setting('app.user_id',true));
ALTER TABLE strategy_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE strategy_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY public_listing ON strategy_listings FOR SELECT USING(status='PUBLISHED' OR tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY own_listing ON strategy_listings FOR ALL USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE marketplace_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY public_version ON marketplace_versions FOR SELECT USING(EXISTS(SELECT 1 FROM strategy_listings s WHERE s.id=listing_id AND (s.status='PUBLISHED' OR s.tenant_id::text=current_setting('app.tenant_id',true))));
CREATE POLICY own_version ON marketplace_versions FOR INSERT WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE subscriptions ADD COLUMN last_event_at timestamptz;
CREATE FUNCTION notify_order_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state IN ('Filled','Rejected','UNKNOWN') THEN
 INSERT INTO notifications(tenant_id,event_key,title) VALUES(NEW.tenant_id,'order:'||NEW.order_id||':'||NEW.state,'ORDER '||upper(NEW.state)) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER notify_order_event AFTER INSERT ON order_events FOR EACH ROW EXECUTE FUNCTION notify_order_event();
CREATE TABLE marketplace_evidence (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, version_id uuid NOT NULL,
 bot_id uuid NOT NULL, environment text NOT NULL CHECK(environment IN ('TESTNET','LIVE')),
 result jsonb NOT NULL, source_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(version_id,bot_id,source_hash), FOREIGN KEY(tenant_id,version_id) REFERENCES marketplace_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id)
);
ALTER TABLE marketplace_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_public ON marketplace_evidence FOR SELECT USING(EXISTS(SELECT 1 FROM marketplace_versions v JOIN strategy_listings s ON s.id=v.listing_id WHERE v.id=version_id AND s.status='PUBLISHED'));
CREATE POLICY own_evidence ON marketplace_evidence FOR ALL USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE paper_sessions ADD COLUMN feed_mode text NOT NULL DEFAULT 'REPLAY' CHECK(feed_mode IN ('REPLAY','MARKET'));
ALTER TABLE paper_sessions ADD COLUMN warmup_bars integer NOT NULL DEFAULT 0;
