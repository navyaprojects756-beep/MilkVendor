-- Add per-order delivery charge for quick/adhoc orders (set in vendor settings)
ALTER TABLE vendor_settings
  ADD COLUMN IF NOT EXISTS adhoc_delivery_charge DECIMAL(10,2) NOT NULL DEFAULT 0;
