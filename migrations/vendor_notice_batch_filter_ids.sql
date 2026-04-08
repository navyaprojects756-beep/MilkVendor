ALTER TABLE vendor_notice_batches
ADD COLUMN IF NOT EXISTS location_apartment_id INT NULL,
ADD COLUMN IF NOT EXISTS location_block_id INT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendor_notice_batches_location_apartment_fk'
  ) THEN
    ALTER TABLE vendor_notice_batches
    ADD CONSTRAINT vendor_notice_batches_location_apartment_fk
    FOREIGN KEY (location_apartment_id) REFERENCES apartments(apartment_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vendor_notice_batches_location_block_fk'
  ) THEN
    ALTER TABLE vendor_notice_batches
    ADD CONSTRAINT vendor_notice_batches_location_block_fk
    FOREIGN KEY (location_block_id) REFERENCES apartment_blocks(block_id);
  END IF;
END $$;
