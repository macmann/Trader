ALTER TABLE exchange_connections ADD COLUMN inventory_started_at timestamptz;
CREATE TABLE connection_inventory (
 tenant_id uuid NOT NULL, connection_id uuid NOT NULL, asset text NOT NULL,
 external_quantity numeric NOT NULL CHECK(external_quantity>=0),
 captured_at timestamptz NOT NULL DEFAULT now(), last_total numeric NOT NULL CHECK(last_total>=0),
 last_checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,connection_id,asset),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES exchange_connections(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE connection_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connection_inventory USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
