ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT;

UPDATE vendors
SET whatsapp_api_number = NULL
WHERE TRIM(COALESCE(whatsapp_api_number, '')) = '';

CREATE UNIQUE INDEX IF NOT EXISTS vendors_whatsapp_api_number_unique_idx
ON vendors ((TRIM(whatsapp_api_number)))
WHERE TRIM(COALESCE(whatsapp_api_number, '')) <> '';
