const pool = require("../db")

/**
 * Generate orders for a vendor on a specific target date.
 * Calling generateOrdersForVendor(vendorId) runs for BOTH today and tomorrow.
 */
async function generateForDate(vendorId, targetDate, hasProducts) {
  const d = targetDate // "YYYY-MM-DD"

  if (hasProducts) {
    // ── Step 1: Create/update orders for customers with active product subscriptions ──
    await pool.query(`
      INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
      SELECT
        cs.customer_id, cs.vendor_id, $2::date,
        COALESCE((
          SELECT SUM(cs2.quantity)
          FROM customer_subscriptions cs2
          WHERE cs2.customer_id = cs.customer_id
            AND cs2.vendor_id   = cs.vendor_id
            AND cs2.is_active   = true
        ), 1)
      FROM customer_subscriptions cs
      JOIN subscriptions s
        ON s.customer_id = cs.customer_id AND s.vendor_id = cs.vendor_id AND s.status = 'active'
      WHERE cs.vendor_id = $1
        AND cs.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM subscription_pauses sp
          WHERE sp.customer_id = cs.customer_id
            AND sp.vendor_id   = cs.vendor_id
            AND $2::date >= sp.pause_from
            AND (sp.pause_until IS NULL OR $2::date <= sp.pause_until)
        )
      GROUP BY cs.customer_id, cs.vendor_id
      ON CONFLICT (customer_id, vendor_id, order_date)
      DO UPDATE SET quantity = EXCLUDED.quantity
      WHERE orders.is_delivered = false
    `, [vendorId, d])

    // ── Step 2: Create/update order_items ──
    await pool.query(`
      INSERT INTO order_items
        (order_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
      SELECT
        o.order_id, cs.product_id, cs.quantity, p.price, p.delivery_charge, 'subscription'
      FROM customer_subscriptions cs
      JOIN subscriptions s
        ON s.customer_id = cs.customer_id AND s.vendor_id = cs.vendor_id AND s.status = 'active'
      JOIN orders o
        ON o.customer_id = cs.customer_id
       AND o.vendor_id   = cs.vendor_id
       AND o.order_date  = $2::date
      JOIN products p ON p.product_id = cs.product_id AND p.is_active = true
      WHERE cs.vendor_id   = $1
        AND cs.is_active   = true
        AND o.is_delivered = false
        AND NOT EXISTS (
          SELECT 1 FROM subscription_pauses sp
          WHERE sp.customer_id = cs.customer_id
            AND sp.vendor_id   = cs.vendor_id
            AND $2::date >= sp.pause_from
            AND (sp.pause_until IS NULL OR $2::date <= sp.pause_until)
        )
      ON CONFLICT (order_id, product_id)
      DO UPDATE SET
        quantity                 = EXCLUDED.quantity,
        price_at_order           = EXCLUDED.price_at_order,
        delivery_charge_at_order = EXCLUDED.delivery_charge_at_order
    `, [vendorId, d])

    // ── Step 3: Remove subscription items for deactivated subscriptions ──
    await pool.query(`
      DELETE FROM order_items oi
      USING orders o
      WHERE oi.order_id   = o.order_id
        AND o.vendor_id   = $1
        AND o.order_date  = $2::date
        AND o.is_delivered = false
        AND oi.order_type = 'subscription'
        AND NOT EXISTS (
          SELECT 1 FROM customer_subscriptions cs
          WHERE cs.customer_id = o.customer_id
            AND cs.product_id  = oi.product_id
            AND cs.is_active   = true
        )
    `, [vendorId, d])

    // ── Step 4: Remove orders with no items and no active subscription ──
    await pool.query(`
      DELETE FROM orders o
      WHERE o.vendor_id    = $1
        AND o.order_date   = $2::date
        AND o.is_delivered = false
        AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id)
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.customer_id = o.customer_id AND s.vendor_id = o.vendor_id AND s.status = 'active'
        )
    `, [vendorId, d])

    // ── Step 5: Remove paused orders (keep if adhoc items exist) ──
    await pool.query(`
      DELETE FROM orders o
      WHERE o.vendor_id    = $1
        AND o.order_date   = $2::date
        AND o.is_delivered = false
        AND EXISTS (
          SELECT 1 FROM subscription_pauses sp
          WHERE sp.customer_id = o.customer_id
            AND sp.vendor_id   = o.vendor_id
            AND $2::date >= sp.pause_from
            AND (sp.pause_until IS NULL OR $2::date <= sp.pause_until)
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.order_id AND oi.order_type = 'adhoc'
        )
    `, [vendorId, d])

  } else {
    // ── LEGACY: original subscriptions-based logic ──
    await pool.query(`
      INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
      SELECT s.customer_id, s.vendor_id, $2::date, s.quantity
      FROM subscriptions s
      WHERE s.status = 'active' AND s.vendor_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM subscription_pauses sp
          WHERE sp.customer_id = s.customer_id AND sp.vendor_id = s.vendor_id
            AND $2::date >= sp.pause_from
            AND (sp.pause_until IS NULL OR $2::date <= sp.pause_until)
        )
      ON CONFLICT (customer_id, vendor_id, order_date)
      DO UPDATE SET quantity = EXCLUDED.quantity
      WHERE orders.is_delivered = false
    `, [vendorId, d])

    await pool.query(`
      DELETE FROM orders o
      WHERE o.vendor_id    = $1
        AND o.order_date   = $2::date
        AND o.is_delivered = false
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.customer_id = o.customer_id AND s.vendor_id = o.vendor_id AND s.status = 'active'
        )
    `, [vendorId, d])

    await pool.query(`
      DELETE FROM orders o
      WHERE o.vendor_id    = $1
        AND o.order_date   = $2::date
        AND o.is_delivered = false
        AND EXISTS (
          SELECT 1 FROM subscription_pauses sp
          WHERE sp.customer_id = o.customer_id AND sp.vendor_id = o.vendor_id
            AND $2::date >= sp.pause_from
            AND (sp.pause_until IS NULL OR $2::date <= sp.pause_until)
        )
    `, [vendorId, d])
  }
}

/** Format a Date as 'YYYY-MM-DD' using local timezone (avoids UTC offset issues). */
function localDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/**
 * Generate orders for both today and tomorrow (no duplicates — ON CONFLICT handles it).
 * Skips already-delivered orders in all cases.
 */
async function generateOrdersForVendor(vendorId) {
  const { rows: prodCheck } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM products WHERE vendor_id = $1 AND is_active = true`,
    [vendorId]
  )
  const hasProducts = parseInt(prodCheck[0].cnt) > 0

  const now = new Date()
  const today    = localDateStr(now)
  const tomorrow = localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))

  await generateForDate(vendorId, today,    hasProducts)
  await generateForDate(vendorId, tomorrow, hasProducts)
}

module.exports = { generateOrdersForVendor }
