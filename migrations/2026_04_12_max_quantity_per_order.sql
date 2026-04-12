BEGIN;

ALTER TABLE vendor_settings
ADD COLUMN IF NOT EXISTS max_quantity_per_order integer;

COMMIT;
