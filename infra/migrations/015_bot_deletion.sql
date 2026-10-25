ALTER TABLE bots ADD COLUMN deleted_at timestamptz;
DROP INDEX one_bot_per_contract;
CREATE UNIQUE INDEX one_bot_per_contract ON bots(tenant_id,connection_id,symbol) WHERE market_type='LINEAR' AND status<>'ARCHIVED';
