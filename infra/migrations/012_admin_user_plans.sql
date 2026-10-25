CREATE TABLE platform_owner (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 user_id uuid UNIQUE NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_owner(user_id) SELECT o.user_id FROM platform_operators o JOIN users u ON u.id=o.user_id ORDER BY u.created_at,u.id LIMIT 1;
CREATE FUNCTION capture_platform_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 INSERT INTO platform_owner(user_id) VALUES(NEW.user_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_platform_owner AFTER INSERT ON platform_operators FOR EACH ROW EXECUTE FUNCTION capture_platform_owner();
ALTER TABLE subscriptions ADD COLUMN admin_plan_override text CHECK(admin_plan_override IN ('FREE','BASIC','PRO'));
ALTER TABLE subscriptions ADD COLUMN admin_override_by uuid REFERENCES users(id);
ALTER TABLE subscriptions ADD COLUMN admin_override_at timestamptz;
CREATE FUNCTION admin_account_directory(search_text text, page_size integer, page_offset integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM platform_operators WHERE user_id=nullif(current_setting('app.user_id',true),'')::uuid) THEN RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF page_size<1 OR page_size>100 OR page_offset<0 OR page_offset>100000 OR length(search_text)>200 THEN RAISE EXCEPTION 'INVALID_DIRECTORY_QUERY'; END IF;
 WITH accounts AS (
 SELECT u.id AS user_id,u.email,u.verified,u.created_at,w.id AS workspace_id,w.name AS workspace_name,w.kind,
 EXISTS(SELECT FROM platform_operators o WHERE o.user_id=u.id) AS platform_admin,
 EXISTS(SELECT FROM platform_owner p WHERE p.user_id=u.id AND w.kind='PERSONAL') AS unlimited,
 s.plan AS billing_plan,s.status AS billing_status,s.period_end,s.admin_plan_override,s.admin_override_at,
 CASE WHEN EXISTS(SELECT FROM platform_owner p WHERE p.user_id=u.id AND w.kind='PERSONAL') THEN 'UNLIMITED'
 WHEN s.admin_plan_override IS NOT NULL THEN s.admin_plan_override
 WHEN s.status='ACTIVE' AND (s.period_end IS NULL OR s.period_end>now()) THEN s.plan ELSE 'FREE' END AS effective_plan,
 (SELECT count(*) FROM bots b WHERE b.tenant_id=w.id AND b.status<>'ARCHIVED') AS bots,
 (SELECT count(*) FROM bots b WHERE b.tenant_id=w.id AND b.status IN ('STARTING','RUNNING')) AS active_bots,
 (SELECT count(*) FROM exchange_connections c WHERE c.tenant_id=w.id) AS connections,
 (SELECT max(created_at) FROM login_history h WHERE h.user_id=u.id AND h.succeeded) AS last_login,
 (SELECT COALESCE(sum(units),0) FROM usage_records r WHERE r.tenant_id=w.id AND r.metric='ai' AND r.created_at>=date_trunc('month',now())) AS ai_usage,
 (SELECT COALESCE(sum(units),0) FROM usage_records r WHERE r.tenant_id=w.id AND r.metric='backtests' AND r.created_at>=date_trunc('month',now())) AS backtest_usage
 FROM users u LEFT JOIN workspaces w ON w.owner_id=u.id LEFT JOIN subscriptions s ON s.tenant_id=w.id
 WHERE u.email ILIKE '%'||search_text||'%' OR w.name ILIKE '%'||search_text||'%'
 ), page AS (SELECT * FROM accounts ORDER BY created_at DESC,user_id,workspace_id LIMIT page_size OFFSET page_offset)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM accounts),'accounts',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,user_id,workspace_id) FROM page),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION admin_set_workspace_plan(target uuid, chosen_plan text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid; previous subscriptions%ROWTYPE; target_owner uuid; target_kind text; old_tenant text := current_setting('app.tenant_id',true);
BEGIN
 IF NOT EXISTS(SELECT FROM platform_operators WHERE user_id=actor) THEN RAISE EXCEPTION 'PLATFORM_ADMIN_REQUIRED' USING ERRCODE='42501'; END IF;
 IF chosen_plan IS NOT NULL AND chosen_plan NOT IN ('FREE','BASIC','PRO') THEN RAISE EXCEPTION 'INVALID_PLAN'; END IF;
 SELECT owner_id,kind INTO target_owner,target_kind FROM workspaces WHERE id=target FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 IF target_kind='PERSONAL' AND EXISTS(SELECT FROM platform_owner WHERE user_id=target_owner) THEN RETURN jsonb_build_object('error','INSTALLATION_OWNER_IS_UNLIMITED'); END IF;
 SELECT * INTO previous FROM subscriptions WHERE tenant_id=target FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND'); END IF;
 UPDATE subscriptions SET admin_plan_override=chosen_plan,admin_override_by=actor,admin_override_at=now(),updated_at=now() WHERE tenant_id=target;
 PERFORM set_config('app.tenant_id',target::text,true);
 INSERT INTO audit_logs(tenant_id,action,data) VALUES(target,'ADMIN_PLAN_CHANGED',jsonb_build_object('actorUserId',actor,'workspaceId',target,'previousOverride',previous.admin_plan_override,'planOverride',chosen_plan,'billingPlan',previous.plan));
 PERFORM set_config('app.tenant_id',coalesce(old_tenant,''),true);
 RETURN jsonb_build_object('ok',true,'planOverride',chosen_plan);
END $$;
REVOKE ALL ON FUNCTION capture_platform_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_account_directory(text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_set_workspace_plan(uuid,text) FROM PUBLIC;
