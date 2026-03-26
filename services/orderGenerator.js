const pool = require("../db")

/**
 * Upsert tomorrow's orders for a vendor based on active subscriptions,
 * and remove orders whose subscriptions are no longer active.
 *
 * @param {number} vendorId
 */
async function generateOrdersForVendor(vendorId) {
  await pool.query(`
    INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
    SELECT s.customer_id, s.vendor_id, CURRENT_DATE + 1, s.quantity
    FROM subscriptions s
    WHERE s.status = 'active' AND s.vendor_id = $1
    ON CONFLICT (customer_id, vendor_id, order_date)
    DO UPDATE SET quantity = EXCLUDED.quantity
  `, [vendorId])

  await pool.query(`
    DELETE FROM orders o
    WHERE o.vendor_id   = $1
      AND o.order_date  = CURRENT_DATE + 1
      AND NOT EXISTS (
        SELECT 1 FROM subscriptions s
        WHERE s.customer_id = o.customer_id
          AND s.vendor_id   = o.vendor_id
          AND s.status      = 'active'
      )
  `, [vendorId])
}

module.exports = { generateOrdersForVendor }
