-- A non-superuser migration owner also obeys FORCE RLS inside this trigger.
CREATE OR REPLACE FUNCTION initialize_workspace() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous_tenant text := current_setting('app.tenant_id',true);
BEGIN
 PERFORM set_config('app.tenant_id',NEW.id::text,true);
 INSERT INTO workspace_members(tenant_id,user_id,role) VALUES(NEW.id,NEW.owner_id,'OWNER');
 INSERT INTO subscriptions(tenant_id) VALUES(NEW.id);
 PERFORM set_config('app.tenant_id',coalesce(previous_tenant,''),true);
 RETURN NEW;
END $$;
