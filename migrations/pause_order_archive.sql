CREATE TABLE IF NOT EXISTS paused_orders_archive (
  archive_id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  vendor_id INT NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  order_date DATE NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  delivery_charge_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_status VARCHAR(10) NOT NULL DEFAULT 'unpaid',
  archived_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, vendor_id, order_date)
);

CREATE TABLE IF NOT EXISTS paused_order_items_archive (
  archive_item_id SERIAL PRIMARY KEY,
  archive_id INT NOT NULL REFERENCES paused_orders_archive(archive_id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  quantity SMALLINT NOT NULL DEFAULT 1,
  price_at_order DECIMAL(10,2) NOT NULL DEFAULT 0,
  delivery_charge_at_order DECIMAL(10,2) NOT NULL DEFAULT 0,
  order_type VARCHAR(20) NOT NULL DEFAULT 'subscription',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_poa_customer_vendor_date
  ON paused_orders_archive(customer_id, vendor_id, order_date);

CREATE INDEX IF NOT EXISTS idx_poi_archive
  ON paused_order_items_archive(archive_id);
