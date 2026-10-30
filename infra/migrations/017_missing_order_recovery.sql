ALTER TABLE orders ADD COLUMN recovery_requested_at timestamptz;
ALTER TABLE orders ADD COLUMN recovery_confirmed_by uuid REFERENCES users(id);
