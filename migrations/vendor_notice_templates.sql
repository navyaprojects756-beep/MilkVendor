CREATE TABLE IF NOT EXISTS whatsapp_notice_reasons (
  reason_id SERIAL PRIMARY KEY,
  reason_code VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  message_text VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_notice_templates (
  notice_template_id SERIAL PRIMARY KEY,
  template_key VARCHAR(100) UNIQUE NOT NULL,
  template_name VARCHAR(150) UNIQUE NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  template_category VARCHAR(50) NOT NULL DEFAULT 'utility',
  language_code VARCHAR(20) NOT NULL DEFAULT 'en_US',
  header_text VARCHAR(120),
  body_text TEXT NOT NULL,
  variable_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_notice_batches (
  notice_batch_id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  template_key VARCHAR(100) NOT NULL,
  reason_code VARCHAR(100),
  filter_from DATE,
  filter_to DATE,
  notice_date DATE,
  notice_from DATE,
  notice_to DATE,
  location_filter VARCHAR(255),
  block_filter VARCHAR(255),
  search_text VARCHAR(255),
  recipient_scope VARCHAR(50) NOT NULL DEFAULT 'filtered',
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'completed',
  created_by_vendor_id INTEGER NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vendor_notice_recipients (
  notice_recipient_id SERIAL PRIMARY KEY,
  notice_batch_id INTEGER NOT NULL REFERENCES vendor_notice_batches(notice_batch_id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(customer_id) ON DELETE SET NULL,
  phone VARCHAR(30) NOT NULL,
  template_key VARCHAR(100) NOT NULL,
  template_name VARCHAR(150) NOT NULL,
  rendered_params JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  wa_message_id VARCHAR(255),
  created_on TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  modified_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_notice_batches_vendor_created_on
  ON vendor_notice_batches(vendor_id, created_on DESC);

CREATE INDEX IF NOT EXISTS idx_vendor_notice_recipients_batch
  ON vendor_notice_recipients(notice_batch_id);

CREATE INDEX IF NOT EXISTS idx_vendor_notice_recipients_vendor_phone
  ON vendor_notice_recipients(vendor_id, phone);

INSERT INTO whatsapp_notice_reasons (reason_code, display_name, message_text, sort_order)
VALUES
  ('vehicle_issue', 'Vehicle Issue', 'vehicle issue', 1),
  ('milk_quality_issue', 'Milk Quality Issue', 'milk quality issue', 2),
  ('supplier_issue', 'Supplier Issue', 'supplier issue', 3),
  ('maintenance_work', 'Maintenance Work', 'maintenance work', 4),
  ('weather_issue', 'Weather Issue', 'weather issue', 5),
  ('holiday', 'Holiday', 'holiday', 6),
  ('other_operational_issue', 'Other Operational Issue', 'other operational issue', 7)
ON CONFLICT (reason_code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  message_text = EXCLUDED.message_text,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  modified_on = NOW();

INSERT INTO whatsapp_notice_templates (
  template_key,
  template_name,
  display_name,
  template_category,
  language_code,
  header_text,
  body_text,
  variable_schema,
  sort_order
)
VALUES
(
  'delivery_unavailable_date',
  'delivery_unavailable_date',
  'No Delivery On Date',
  'utility',
  'en_US',
  'Service Update',
  'Dear customer, we will not be able to deliver on {{1}} due to {{2}}. Thank you for your understanding.',
  '[{"key":"notice_date","label":"Delivery Date","source":"vendor_input","type":"date"},{"key":"reason_code","label":"Reason","source":"reason_lookup","type":"select"}]'::jsonb,
  1
),
(
  'delivery_unavailable_from_to',
  'delivery_unavailable_from_to',
  'No Delivery Date Range',
  'utility',
  'en_US',
  'Service Update',
  'Dear customer, your scheduled milk delivery will be unavailable from {{1}} to {{2}} due to {{3}}. Thank you for your understanding.',
  '[{"key":"notice_from","label":"From Date","source":"vendor_input","type":"date"},{"key":"notice_to","label":"To Date","source":"vendor_input","type":"date"},{"key":"reason_code","label":"Reason","source":"reason_lookup","type":"select"}]'::jsonb,
  2
),
(
  'payment_due_reminder',
  'payment_due_reminder',
  'Payment Due Reminder',
  'utility',
  'en_US',
  'Payment Reminder',
  'Dear customer, your payment of Rs.{{1}} for the period from {{2}} to {{3}} is pending. You can request your PDF bill directly from the WhatsApp menu. Thank you.',
  '[{"key":"amount","label":"Outstanding Amount","source":"backend_calculated","type":"currency"},{"key":"filter_from","label":"Period From","source":"vendor_input","type":"date"},{"key":"filter_to","label":"Period To","source":"vendor_input","type":"date"}]'::jsonb,
  3
)
ON CONFLICT (template_key) DO UPDATE SET
  template_name = EXCLUDED.template_name,
  display_name = EXCLUDED.display_name,
  template_category = EXCLUDED.template_category,
  language_code = EXCLUDED.language_code,
  header_text = EXCLUDED.header_text,
  body_text = EXCLUDED.body_text,
  variable_schema = EXCLUDED.variable_schema,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  modified_on = NOW();
