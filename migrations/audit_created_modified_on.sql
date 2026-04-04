CREATE OR REPLACE FUNCTION set_created_modified_on()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_on := COALESCE(NEW.created_on, NOW());
    NEW.modified_on := COALESCE(NEW.modified_on, NEW.created_on, NOW());
  ELSE
    NEW.created_on := COALESCE(NEW.created_on, OLD.created_on, NOW());
    NEW.modified_on := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'apartment_blocks',
    'apartments',
    'bills',
    'conversation_state',
    'customer_subscriptions',
    'customer_vendor_profile',
    'customers',
    'messages',
    'order_items',
    'orders',
    'payments',
    'product_price_history',
    'products',
    'subscription_pauses',
    'subscriptions',
    'vendor_profile',
    'vendor_settings',
    'vendors'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_on TIMESTAMPTZ', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS modified_on TIMESTAMPTZ', t);
  END LOOP;
END $$;

DO $$
DECLARE
  t text;
  has_created_at boolean;
  tables text[] := ARRAY[
    'apartment_blocks',
    'apartments',
    'bills',
    'conversation_state',
    'customer_subscriptions',
    'customer_vendor_profile',
    'customers',
    'messages',
    'order_items',
    'orders',
    'payments',
    'product_price_history',
    'products',
    'subscription_pauses',
    'subscriptions',
    'vendor_profile',
    'vendor_settings',
    'vendors'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = t
        AND column_name = 'created_at'
    ) INTO has_created_at;

    IF has_created_at THEN
      EXECUTE format(
        'UPDATE %I
         SET created_on = COALESCE(created_on, created_at, NOW()),
             modified_on = COALESCE(modified_on, created_on, created_at, NOW())
         WHERE created_on IS NULL OR modified_on IS NULL',
        t
      );
    ELSE
      EXECUTE format(
        'UPDATE %I
         SET created_on = COALESCE(created_on, NOW()),
             modified_on = COALESCE(modified_on, created_on, NOW())
         WHERE created_on IS NULL OR modified_on IS NULL',
        t
      );
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN created_on SET DEFAULT NOW()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN modified_on SET DEFAULT NOW()', t);
  END LOOP;
END $$;

DO $$
DECLARE
  t text;
  trig text;
  tables text[] := ARRAY[
    'apartment_blocks',
    'apartments',
    'bills',
    'conversation_state',
    'customer_subscriptions',
    'customer_vendor_profile',
    'customers',
    'messages',
    'order_items',
    'orders',
    'payments',
    'product_price_history',
    'products',
    'subscription_pauses',
    'subscriptions',
    'vendor_profile',
    'vendor_settings',
    'vendors'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    trig := 'trg_set_created_modified_on_' || t;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trig, t);
    EXECUTE format(
      'CREATE TRIGGER %I
       BEFORE INSERT OR UPDATE ON %I
       FOR EACH ROW
       EXECUTE FUNCTION set_created_modified_on()',
      trig, t
    );
  END LOOP;
END $$;
