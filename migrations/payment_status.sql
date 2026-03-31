-- Add payment_status to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(10) NOT NULL DEFAULT 'unpaid';
CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);

-- Add period + verification columns to payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_from  DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS period_to    DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_verified  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_revoked   BOOLEAN NOT NULL DEFAULT false;
