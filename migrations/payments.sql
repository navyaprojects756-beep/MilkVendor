-- Payments table for tracking customer payments
CREATE TABLE IF NOT EXISTS payments (
  payment_id      SERIAL PRIMARY KEY,
  customer_id     INT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  vendor_id       INT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  amount          DECIMAL(10,2) NOT NULL,
  payment_method  VARCHAR(20) NOT NULL DEFAULT 'cash', -- cash, phonePe, upi, other
  notes           TEXT,
  screenshot_url  TEXT,
  recorded_by     VARCHAR(10) NOT NULL DEFAULT 'vendor', -- 'customer' or 'vendor'
  payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_vendor   ON payments(vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_date     ON payments(payment_date);

-- Bills table: snapshot of monthly bills per customer
CREATE TABLE IF NOT EXISTS bills (
  bill_id         SERIAL PRIMARY KEY,
  customer_id     INT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  vendor_id       INT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  period_label    VARCHAR(20) NOT NULL, -- e.g. "2026-03"
  total_amount    DECIMAL(10,2) NOT NULL,
  total_quantity  INT NOT NULL,
  pdf_url         TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(customer_id, period_label)
);

CREATE INDEX IF NOT EXISTS idx_bills_customer ON bills(customer_id);
CREATE INDEX IF NOT EXISTS idx_bills_vendor   ON bills(vendor_id);

-- show_phone_numbers column (if not already added)
ALTER TABLE vendor_settings ADD COLUMN IF NOT EXISTS show_phone_numbers BOOLEAN NOT NULL DEFAULT true;

-- payment_screenshots upload dir is served from /uploads/payments/
