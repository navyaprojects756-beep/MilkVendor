ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_charge_amount DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE vendor_settings
  ADD COLUMN IF NOT EXISTS apply_delivery_charge_on_subscription BOOLEAN NOT NULL DEFAULT false;

UPDATE orders o
SET delivery_charge_amount = src.total_delivery
FROM (
  SELECT order_id, COALESCE(SUM(delivery_charge_at_order), 0) AS total_delivery
  FROM order_items
  GROUP BY order_id
) src
WHERE o.order_id = src.order_id
  AND COALESCE(o.delivery_charge_amount, 0) = 0;
