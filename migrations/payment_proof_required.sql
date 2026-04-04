ALTER TABLE vendor_settings
ADD COLUMN IF NOT EXISTS payment_proof_required boolean NOT NULL DEFAULT false;
