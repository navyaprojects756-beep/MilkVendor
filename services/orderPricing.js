const pool = require("../db")

function toNumber(value) {
  const num = parseFloat(value || 0)
  return Number.isFinite(num) ? num : 0
}

async function getVendorDeliveryPolicy(vendorId, client = pool) {
  const { rows } = await client.query(
    `SELECT
       COALESCE(adhoc_delivery_charge, 0) AS order_delivery_charge,
       COALESCE(apply_delivery_charge_on_subscription, false) AS apply_delivery_charge_on_subscription
     FROM vendor_settings
     WHERE vendor_id = $1`,
    [vendorId]
  )

  return {
    orderDeliveryCharge: toNumber(rows[0]?.order_delivery_charge),
    applyOnSubscription: rows[0]?.apply_delivery_charge_on_subscription === true,
  }
}

function computeOrderDeliveryCharge(items = [], policy = {}) {
  const orderDeliveryCharge = toNumber(policy.orderDeliveryCharge)
  if (orderDeliveryCharge <= 0) return 0

  const normalized = items.filter((item) => toNumber(item.quantity) > 0)
  const hasAdhoc = normalized.some((item) => item.order_type === "adhoc")
  const hasSubscription = normalized.some((item) => item.order_type === "subscription")

  if (hasAdhoc) return orderDeliveryCharge
  if (hasSubscription && policy.applyOnSubscription) return orderDeliveryCharge
  return 0
}

async function refreshOrderTotals(orderId, client = pool) {
  const orderRes = await client.query(
    "SELECT order_id, vendor_id FROM orders WHERE order_id = $1",
    [orderId]
  )
  const order = orderRes.rows[0]
  if (!order) return null

  const itemsRes = await client.query(
    `SELECT quantity, order_type
     FROM order_items
     WHERE order_id = $1`,
    [orderId]
  )

  const quantity = itemsRes.rows.reduce((sum, item) => sum + toNumber(item.quantity), 0)
  const policy = await getVendorDeliveryPolicy(order.vendor_id, client)
  const deliveryChargeAmount = computeOrderDeliveryCharge(itemsRes.rows, policy)

  await client.query(
    `UPDATE orders
     SET quantity = $2,
         delivery_charge_amount = $3
     WHERE order_id = $1`,
    [orderId, quantity, deliveryChargeAmount]
  )

  return { quantity, deliveryChargeAmount, policy }
}

function getOrderDeliveryAmount(order = {}) {
  const direct = toNumber(order.delivery_charge_amount)
  if (direct > 0) return direct

  const items = Array.isArray(order.items) ? order.items : []
  return items.reduce((sum, item) => sum + toNumber(item.delivery_charge_at_order), 0)
}

function getOrderItemsSubtotal(order = {}) {
  const items = Array.isArray(order.items) ? order.items : []
  return items.reduce(
    (sum, item) => sum + (toNumber(item.quantity) * toNumber(item.price_at_order)),
    0
  )
}

function getOrderTotal(order = {}, pricePerUnit = 0) {
  const hasItems = Array.isArray(order.items) && order.items.length > 0
  const itemSubtotal = hasItems
    ? getOrderItemsSubtotal(order)
    : toNumber(order.quantity) * toNumber(pricePerUnit)

  return itemSubtotal + getOrderDeliveryAmount(order)
}

module.exports = {
  toNumber,
  getVendorDeliveryPolicy,
  computeOrderDeliveryCharge,
  refreshOrderTotals,
  getOrderDeliveryAmount,
  getOrderItemsSubtotal,
  getOrderTotal,
}
