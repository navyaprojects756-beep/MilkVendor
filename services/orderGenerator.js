const pool = require("../db")

/**
 * Upsert tomorrow's orders for a vendor based on active, non-paused subscriptions.
 * Removes orders for inactive or paused subscriptions.
 */
async function generateOrdersForVendor(vendorId) {
  // 1. Insert/update orders for active subscriptions that are NOT paused tomorrow
  await pool.query(`
    INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
    SELECT s.customer_id, s.vendor_id, CURRENT_DATE + 1, s.quantity
    FROM subscriptions s
    WHERE s.status = 'active'
      AND s.vendor_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM subscription_pauses sp
        WHERE sp.customer_id = s.customer_id
          AND sp.vendor_id   = s.vendor_id
          AND (CURRENT_DATE + 1) >= sp.pause_from
          AND (sp.pause_until IS NULL OR (CURRENT_DATE + 1) <= sp.pause_until)
      )
    ON CONFLICT (customer_id, vendor_id, order_date)
    DO UPDATE SET quantity = EXCLUDED.quantity
    WHERE orders.is_delivered = false
  `, [vendorId])

  // 2. Remove orders for inactive subscriptions (skip already-delivered)
  await pool.query(`
    DELETE FROM orders o
    WHERE o.vendor_id    = $1
      AND o.order_date   = CURRENT_DATE + 1
      AND o.is_delivered = false
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.customer_id = o.customer_id
          AND s.vendor_id   = o.vendor_id
          AND s.status      = 'active'
      )
  `, [vendorId])

  // 3. Remove orders for customers who are paused tomorrow (skip already-delivered)
  await pool.query(`
    DELETE FROM orders o
    WHERE o.vendor_id    = $1
      AND o.order_date   = CURRENT_DATE + 1
      AND o.is_delivered = false
      AND EXISTS (
        SELECT 1 FROM subscription_pauses sp
        WHERE sp.customer_id = o.customer_id
          AND sp.vendor_id   = o.vendor_id
          AND (CURRENT_DATE + 1) >= sp.pause_from
          AND (sp.pause_until IS NULL OR (CURRENT_DATE + 1) <= sp.pause_until)
      )
  `, [vendorId])
}

module.exports = { generateOrdersForVendor }
