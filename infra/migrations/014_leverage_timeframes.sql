ALTER TABLE bots DROP CONSTRAINT bots_timeframe;
ALTER TABLE bots ADD CONSTRAINT bots_timeframe CHECK(timeframe IN ('5','15','30','60','240','1440'));
ALTER TABLE bots ADD COLUMN leverage integer NOT NULL DEFAULT 1 CHECK(leverage BETWEEN 1 AND 20);
ALTER TABLE bots ADD CONSTRAINT spot_leverage_one CHECK(market_type='LINEAR' OR leverage=1);
ALTER TABLE orders ADD COLUMN leverage integer NOT NULL DEFAULT 1 CHECK(leverage BETWEEN 1 AND 20);
ALTER TABLE orders ADD CONSTRAINT spot_order_leverage_one CHECK(market_type='LINEAR' OR leverage=1);
