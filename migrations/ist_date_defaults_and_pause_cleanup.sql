-- Recommended IST-safe DB updates
-- Run this once in PostgreSQL if you want DB-level defaults to align with the app's IST behavior.

BEGIN;

-- 1. Make date defaults IST-safe for any future inserts that rely on table defaults.
ALTER TABLE payments
  ALTER COLUMN payment_date
  SET DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date);

ALTER TABLE product_price_history
  ALTER COLUMN effective_from
  SET DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date);

-- 2. Clean up duplicate active/upcoming pauses created before the latest pause fix.
-- Keeps only the newest active/upcoming pause per customer/vendor.
WITH ranked AS (
  SELECT
    pause_id,
    ROW_NUMBER() OVER (
      PARTITION BY customer_id, vendor_id
      ORDER BY pause_from DESC, pause_id DESC
    ) AS rn
  FROM subscription_pauses
  WHERE pause_until IS NULL
     OR pause_until >= ((now() AT TIME ZONE 'Asia/Kolkata')::date)
)
DELETE FROM subscription_pauses sp
USING ranked r
WHERE sp.pause_id = r.pause_id
  AND r.rn > 1;

COMMIT;
