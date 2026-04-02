-- ================================================================
-- Multi-product support migration
-- Creates: products, product_price_history, customer_subscriptions,
--          order_items, messages tables
-- Adds:    vendor_settings.vendor_phone column
-- Run once against your PostgreSQL database.
-- ================================================================

-- 1. Products catalog per vendor
CREATE TABLE IF NOT EXISTS products (
  product_id       SERIAL PRIMARY KEY,
  vendor_id        INT          NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  name             VARCHAR(100) NOT NULL,
  unit             VARCHAR(40)  NOT NULL DEFAULT '',         -- e.g. "500 ml", "200 g"
  price            DECIMAL(10,2) NOT NULL,
  delivery_charge  DECIMAL(10,2) NOT NULL DEFAULT 0,
  order_type       VARCHAR(20)  NOT NULL DEFAULT 'both',     -- 'subscription' | 'adhoc' | 'both'
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  sort_order       INT          NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- 2. Price + delivery-charge history (snapshot on each change)
CREATE TABLE IF NOT EXISTS product_price_history (
  history_id       SERIAL PRIMARY KEY,
  product_id       INT          NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  price            DECIMAL(10,2) NOT NULL,
  delivery_charge  DECIMAL(10,2) NOT NULL DEFAULT 0,
  effective_from   DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pph_product_date
  ON product_price_history(product_id, effective_from DESC);

-- 3. Per-customer, per-product subscriptions
CREATE TABLE IF NOT EXISTS customer_subscriptions (
  subscription_id  SERIAL PRIMARY KEY,
  customer_id      INT          NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  vendor_id        INT          NOT NULL REFERENCES vendors(vendor_id)  ON DELETE CASCADE,
  product_id       INT          NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  quantity         SMALLINT     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_cs_vendor   ON customer_subscriptions(vendor_id, is_active);
CREATE INDEX IF NOT EXISTS idx_cs_customer ON customer_subscriptions(customer_id);

-- 4. Order line items (one row per product per order)
CREATE TABLE IF NOT EXISTS order_items (
  item_id                  SERIAL PRIMARY KEY,
  order_id                 INT          NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id               INT          NOT NULL REFERENCES products(product_id),
  quantity                 SMALLINT     NOT NULL DEFAULT 1,
  price_at_order           DECIMAL(10,2) NOT NULL,   -- price snapshot at order creation
  delivery_charge_at_order DECIMAL(10,2) NOT NULL DEFAULT 0,
  order_type               VARCHAR(20)  NOT NULL DEFAULT 'subscription', -- 'subscription' | 'adhoc'
  created_at               TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id);

-- 5. Unhandled WhatsApp message inbox
CREATE TABLE IF NOT EXISTS messages (
  message_id    SERIAL PRIMARY KEY,
  vendor_id     INT          NOT NULL REFERENCES vendors(vendor_id) ON DELETE CASCADE,
  customer_id   INT          REFERENCES customers(customer_id) ON DELETE SET NULL,
  phone         VARCHAR(20)  NOT NULL,
  direction     VARCHAR(10)  NOT NULL DEFAULT 'inbound',  -- 'inbound' | 'outbound'
  message_type  VARCHAR(20)  NOT NULL DEFAULT 'text',     -- 'text' | 'image' | 'document' | 'audio'
  content       TEXT,
  media_id      TEXT,
  is_read       BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msg_vendor_phone
  ON messages(vendor_id, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_unread
  ON messages(vendor_id, is_read) WHERE direction = 'inbound';

-- 6. Vendor phone for auto-reply message
ALTER TABLE vendor_settings ADD COLUMN IF NOT EXISTS vendor_phone VARCHAR(20);
