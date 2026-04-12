ALTER TABLE order_items
DROP CONSTRAINT IF EXISTS order_items_order_id_product_id_key;

DROP INDEX IF EXISTS order_items_order_id_product_id_key;

ALTER TABLE order_items
ADD CONSTRAINT order_items_order_id_product_id_order_type_key
UNIQUE (order_id, product_id, order_type);
