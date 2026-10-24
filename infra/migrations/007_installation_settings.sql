-- Installation-wide records are server-only; tenant administrators are not platform operators.
CREATE TABLE platform_operators(user_id uuid PRIMARY KEY REFERENCES users(id));
CREATE TABLE installation_setup(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), token_hash text NOT NULL);
CREATE TABLE platform_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), encrypted_value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION claim_installation(token text, uid uuid, email_address text, password_digest text, workspace uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expected text; previous_tenant text := current_setting('app.tenant_id',true);
BEGIN
 SELECT token_hash INTO expected FROM installation_setup WHERE singleton FOR UPDATE;
 IF expected IS NULL OR expected<>token OR EXISTS(SELECT FROM platform_operators) OR EXISTS(SELECT FROM users) THEN RETURN false; END IF;
 INSERT INTO users(id,email,password_hash,verified) VALUES(uid,email_address,password_digest,true);
 INSERT INTO workspaces(id,owner_id) VALUES(workspace,uid);
 INSERT INTO platform_operators(user_id) VALUES(uid);
 PERFORM set_config('app.tenant_id',workspace::text,true);
 INSERT INTO audit_logs(tenant_id,action,data) VALUES(workspace,'INSTALLATION_INITIALIZED',jsonb_build_object('userId',uid));
 PERFORM set_config('app.tenant_id',coalesce(previous_tenant,''),true);
 DELETE FROM installation_setup;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION claim_installation(text,uuid,text,text,uuid) FROM PUBLIC;
