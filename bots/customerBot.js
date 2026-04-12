const axios = require("axios")
const path  = require("path")
const fs    = require("fs")
const pool  = require("../db")
const { generateInvoicePDF }     = require("../services/invoicePDF")
const { refreshOrderTotals, getVendorDeliveryPolicy, computeOrderDeliveryCharge } = require("../services/orderPricing")
const { generateOrdersForVendor } = require("../services/orderGenerator")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

/* --- WHATSAPP API --------------------------------------- */

async function sendWhatsApp(pid, payload) {
  try {
    if (payload?.type === "interactive" && payload?.interactive?.type === "flow") {
      console.log("[WA FLOW SEND]", JSON.stringify({
        pid,
        to: payload.to,
        flow_id: payload.interactive?.action?.parameters?.flow_id,
        flow_token: payload.interactive?.action?.parameters?.flow_token,
        flow_cta: payload.interactive?.action?.parameters?.flow_cta,
        flow_action: payload.interactive?.action?.parameters?.flow_action,
      }, null, 2))
    }
    await axios.post(
      `https://graph.facebook.com/v18.0/${pid}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    )
    if (payload?.type === "interactive" && payload?.interactive?.type === "flow") {
      console.log("[WA FLOW SEND OK]")
    }
    return true
  } catch (err) {
    console.error("WhatsApp Error:", JSON.stringify(err.response?.data || err.message, null, 2))
    return false
  }
}

async function sendText(pid, phone, text) {
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: text }
  })
}

// -- Shared flow ids --
const REGISTRATION_FLOW_ID        = process.env.REGISTRATION_FLOW_ID
const PRODUCT_LIST_FLOW_ID        = process.env.PRODUCT_LIST_FLOW_ID

// -- Send Product List flow as free interactive message (within 24h session) --
async function sendProductListFlow(pid, phone, customerId, vendorId, bodyText, mode = "sub", ctaText = null) {
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to:   phone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: bodyText || "*Your Daily Products*\n\nSet your daily quantity for each product below." },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token:           `${vendorId}:${customerId}:${mode}`,
          flow_id:              PRODUCT_LIST_FLOW_ID,
          flow_cta:             ctaText || (mode === "adhoc" ? "Order Tomorrow" : "Daily Products"),
          flow_action:          "data_exchange"
        }
      }
    }
  })
}

// -- Send address update as free interactive message (within session, not template) --
async function sendAddressUpdateFlow(pid, phone, vendorId, customerId, businessName, currentName, currentAddr) {
  const nameLine = currentName ? `*Name:* ${currentName}\n` : ""
  const addrLine = currentAddr ? `*Current:* ${currentAddr}\n` : ""
  const currentSummary = nameLine || addrLine ? `${nameLine}${addrLine}\n` : ""
  return await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to:   phone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: `${currentSummary}Please review and update your profile details below.` },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token:           `${vendorId}:${customerId}:update`,
          flow_id:              process.env.REGISTRATION_FLOW_ID,
          flow_cta:             "Edit Profile",
          flow_action:          "data_exchange"
        }
      }
    }
  })
}

async function sendRegistrationFlow(pid, phone, vendorId, customerId, businessName) {
  console.log("[REG FLOW]", JSON.stringify({ pid, phone, vendorId, customerId, businessName, REGISTRATION_FLOW_ID }, null, 2))
  return await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: "Please complete your profile to start deliveries." },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: `${vendorId}:${customerId}:new`,
          flow_id: REGISTRATION_FLOW_ID,
          flow_cta: "Register Now",
          flow_action: "data_exchange"
        }
      }
    }
  })
}

function computeCartDeliveryCharge(cart = [], policy = {}) {
  return computeOrderDeliveryCharge(
    cart.map((item) => ({
      quantity: item.qty || item.quantity || 0,
      order_type: item.order_type || "adhoc",
    })),
    policy
  )
}

function buildCartOrderSummary(cart = [], deliveryCharge = 0, tomorrow, profile = {}) {
  const lines = cart.map((item) => {
    const cost = (parseFloat(item.price || 0) * parseFloat(item.qty || 0)).toFixed(2)
    return `• ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} x ${item.qty} - Rs.${cost}`
  }).join("\n")
  const itemTotal = cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * parseFloat(item.qty || 0)), 0)
  const grandTotal = (itemTotal + parseFloat(deliveryCharge || 0)).toFixed(2)
  const deliveryLine = parseFloat(deliveryCharge || 0) > 0
    ? `\n\u{1F69A} Delivery - Rs.${parseFloat(deliveryCharge || 0).toFixed(2)}`
    : `\n\u{1F69A} Delivery - Free`
  const timingParts = []
  if (profile?.delivery_start) timingParts.push(formatTime12(profile.delivery_start))
  if (profile?.delivery_end) timingParts.push(formatTime12(profile.delivery_end))
  const timingLine = timingParts.length === 2
    ? `\n\u{1F551} Delivery Time: ${timingParts[0]} to ${timingParts[1]}`
    : ""

  return `\u{1F4E6} *Order Summary*\n\n${lines}${deliveryLine}\n\n*Total: Rs.${grandTotal}*\n\u{1F4C5} Delivery Date: ${displayDate(tomorrow)}${timingLine}\n\nConfirm your order?`
}

function buildPlacedOrderFallback(cart = [], deliveryCharge = 0, tomorrow, addr = null, profile = {}) {
  const lines = cart.map((item) =>
    `• ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} x ${item.qty} - Rs.${(parseFloat(item.price || 0) * parseFloat(item.qty || 0)).toFixed(2)}`
  ).join("\n")
  const itemTotal = cart.reduce((sum, item) => sum + (parseFloat(item.price || 0) * parseFloat(item.qty || 0)), 0)
  const grandTotal = (itemTotal + parseFloat(deliveryCharge || 0)).toFixed(2)
  const deliveryLine = parseFloat(deliveryCharge || 0) > 0
    ? `\n\u{1F69A} Delivery - Rs.${parseFloat(deliveryCharge || 0).toFixed(2)}`
    : `\n\u{1F69A} Delivery - Free`
  const timingParts = []
  if (profile?.delivery_start) timingParts.push(formatTime12(profile.delivery_start))
  if (profile?.delivery_end) timingParts.push(formatTime12(profile.delivery_end))
  const timingLine = timingParts.length === 2
    ? `\n\u{1F551} Delivery Time: ${timingParts[0]} to ${timingParts[1]}`
    : ""
  const addressLine = addr ? `\n\u{1F4CD} ${formatAddress(addr)}` : ""

  return `\u{1F4E6} *Order Placed!*\n\n${lines}${deliveryLine}\n\n*Total: Rs.${grandTotal}*${addressLine}\n\u{1F4C5} Delivery Date: ${displayDate(tomorrow)}${timingLine}\n\nThank you!`
}

async function sendList(pid, phone, body, rows, btnLabel = "Select") {
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: btnLabel, sections: [{ title: "Options", rows }] }
    }
  })
}

// Up to 3 quick-reply buttons
async function sendButtons(pid, phone, body, buttons) {
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title }
        }))
      }
    }
  })
}

/* --- HELPERS -------------------------------------------- */

function nav(rows) {
  return [...rows, { id: "menu", title: "Main Menu" }]
}

function formatAddress(addr) {
  if (!addr) return "Not set"
  if (addr.address_type === "apartment") {
    const parts = []
    if (addr.flat_number)    parts.push(`Flat ${addr.flat_number}`)
    if (addr.block_name)     parts.push(`Block ${addr.block_name}`)
    if (addr.apartment_name) parts.push(addr.apartment_name)
    return parts.length ? parts.join(", ") : "Apartment (incomplete)"
  }
  return addr.manual_address || "Not set"
}

function formatTime12(value) {
  if (!value) return ""
  const [hourRaw, minuteRaw] = String(value).split(":")
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return String(value)
  const period = hour >= 12 ? "PM" : "AM"
  const hour12 = ((hour + 11) % 12) + 1
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`
}

function formatActiveDays(activeDays = []) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const normalized = (activeDays || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  const days = normalized.length ? normalized : [0, 1, 2, 3, 4, 5, 6]
  return days.map((d) => labels[d]).join(", ")
}

function formatDeliveryWindow(profile = {}) {
  if (!profile?.delivery_start || !profile?.delivery_end) return ""
  return `\nDelivery Time: ${formatTime12(profile.delivery_start)} to ${formatTime12(profile.delivery_end)}`
}

function formatOrderWindowText(start, end) {
  if (!start || !end) return ""
  const toMins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m }
  const startMins = toMins(start)
  const endMins = toMins(end)
  if (startMins === endMins) return `${formatTime12(start)} to ${formatTime12(end)}`
  if (startMins < endMins) return `${formatTime12(start)} to ${formatTime12(end)}`
  return `${formatTime12(start)} to next day ${formatTime12(end)}`
}

function isOrderWindowOpen(settings, profile = {}) {
  if (!settings.order_window_enabled) return true
  const now = getISTNow()
  const activeDays = (profile.active_days || settings.active_days || [0, 1, 2, 3, 4, 5, 6]).map(Number)
  const acceptStartValue = profile.order_accept_start || settings.order_accept_start
  const acceptEndValue = profile.order_accept_end || settings.order_accept_end
  if (!acceptStartValue || !acceptEndValue) return true
  const toMins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m }
  const startMins = toMins(acceptStartValue)
  const endMins = toMins(acceptEndValue)
  const nowMins = now.getHours() * 60 + now.getMinutes()
  if (startMins === endMins) return false
  const isOvernight = startMins > endMins
  const windowDay = isOvernight && nowMins <= endMins ? (now.getDay() + 6) % 7 : now.getDay()
  if (!activeDays.includes(windowDay)) return false
  if (startMins < endMins) return nowMins >= startMins && nowMins <= endMins
  return nowMins >= startMins || nowMins <= endMins
}

async function sendOrderWindowClosedMessage(pid, phone, settings, profile = {}) {
  const s = profile.order_accept_start || settings.order_accept_start || "—"
  const e = profile.order_accept_end   || settings.order_accept_end || "—"
  const days = formatActiveDays(profile.active_days || settings.active_days)
  await sendText(pid, phone,
    `*Order window is currently closed.*\n\nWe accept order updates from *${formatOrderWindowText(s, e)}* on *${days}*.\n\nChanges can only be made during these hours.`
  )
}

/* --- DATE HELPERS --------------------------------------- */

function getISTNow() {
  const now = new Date()
  return new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
}

function getISTDateStr(offsetDays = 0) {
  const ist = getISTNow()
  const date = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function istTomorrowStr() {
  return getISTDateStr(1)
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function dateToStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function displayDate(val) {
  if (!val) return "-"
  const fmt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    const [yr, mo, dy] = val.split("-").map(Number)
    return fmt.format(new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0)))
  }
  const date = val instanceof Date ? val : new Date(val)
  return fmt.format(date)
}


/* --- DB HELPERS ----------------------------------------- */

async function hasVendorProducts(vendorId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt FROM products WHERE vendor_id=$1 AND is_active=true`,
    [vendorId]
  )
  return parseInt(r.rows[0].cnt) > 0
}

async function getVendorProducts(vendorId, orderType = null) {
  let q = `SELECT product_id, name, unit, price, delivery_charge, order_type, sort_order
           FROM products WHERE vendor_id=$1 AND is_active=true`
  const params = [vendorId]
  if (orderType) {
    q += ` AND (order_type=$2 OR order_type='both')`
    params.push(orderType)
  }
  q += ` ORDER BY sort_order, product_id`
  return (await pool.query(q, params)).rows
}

async function getCustomerProductSubs(cId, vId) {
  const r = await pool.query(`
    SELECT cs.subscription_id, cs.product_id, cs.quantity, cs.is_active,
           p.name, p.unit, p.price, p.delivery_charge, p.order_type
    FROM customer_subscriptions cs
    JOIN products p ON p.product_id = cs.product_id AND p.is_active = true
    WHERE cs.customer_id=$1 AND cs.vendor_id=$2
    ORDER BY p.sort_order, p.product_id
  `, [cId, vId])
  return r.rows
}

async function getUpcomingAdhocOrders(cId, vId, restored = null) {
  const tomorrow = getISTDateStr(1)
  const liveRes = await pool.query(
    `SELECT o.order_id, o.order_date, COALESCE(o.delivery_charge_amount, 0) AS delivery_charge_amount,
            oi.quantity, oi.price_at_order, oi.delivery_charge_at_order,
            p.name, p.unit, p.sort_order, p.product_id
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.order_id
     JOIN products p ON p.product_id = oi.product_id
     WHERE o.customer_id=$1
       AND o.vendor_id=$2
       AND COALESCE(o.is_delivered, false)=false
       AND o.order_date >= $3
       AND oi.order_type='adhoc'
     ORDER BY o.order_date ASC, p.sort_order, p.product_id`,
    [cId, vId, tomorrow]
  )

  if (liveRes.rows.length) {
    const grouped = []
    let current = null
    for (const row of liveRes.rows) {
      if (!current || String(current.orderDate) !== String(row.order_date)) {
        current = {
          orderDate: row.order_date,
          deliveryCharge: parseFloat(row.delivery_charge_amount || 0),
          items: [],
        }
        grouped.push(current)
      }
      current.items.push({
        quantity: row.quantity,
        name: row.name,
        unit: row.unit,
        price_at_order: row.price_at_order,
        delivery_charge_at_order: row.delivery_charge_at_order,
      })
    }
    return grouped
  }

  if (restored?.adhocItems?.length) {
    const productMapRes = await pool.query(
      `SELECT product_id, name, unit FROM products WHERE vendor_id=$1 ORDER BY sort_order, product_id`,
      [vId]
    )
    const productMap = new Map(productMapRes.rows.map((p) => [String(p.product_id), p]))
    return [{
      orderDate: restored.nextAdhocDate,
      deliveryCharge: 0,
      items: restored.adhocItems.map((item) => {
        const product = productMap.get(String(item.product_id)) || {}
        return {
          quantity: item.quantity,
          name: product.name || "Product",
          unit: product.unit || "",
          price_at_order: item.price_at_order,
          delivery_charge_at_order: item.delivery_charge_at_order,
        }
      }),
    }]
  }

  return []
}

async function getUpcomingOrderSections(cId, vId) {
  const tomorrow = getISTDateStr(1)
  const res = await pool.query(
    `SELECT
       o.order_date,
       COALESCE(o.delivery_charge_amount, 0) AS delivery_charge_amount,
       COALESCE(oi.order_type, 'subscription') AS order_type,
       oi.quantity,
       oi.price_at_order,
       oi.delivery_charge_at_order,
       oi.product_id,
       p.name,
       p.unit,
       p.sort_order
     FROM orders o
     JOIN order_items oi ON oi.order_id = o.order_id
     LEFT JOIN products p ON p.product_id = oi.product_id
     WHERE o.customer_id=$1
       AND o.vendor_id=$2
       AND COALESCE(o.is_delivered, false)=false
       AND o.order_date >= $3
     ORDER BY o.order_date ASC, CASE WHEN COALESCE(oi.order_type, 'subscription')='subscription' THEN 0 ELSE 1 END, p.sort_order, oi.product_id`,
    [cId, vId, tomorrow]
  )

  const sections = []
  let current = null
  for (const row of res.rows) {
    if (!current || String(current.orderDate) !== String(row.order_date)) {
      current = {
        orderDate: row.order_date,
        deliveryCharge: parseFloat(row.delivery_charge_amount || 0),
        dailyItems: [],
        adhocItems: [],
      }
      sections.push(current)
    }

    const item = {
      quantity: row.quantity,
      price_at_order: row.price_at_order,
      name: row.name || `Product #${row.product_id}`,
      unit: row.unit || "",
    }

    if ((row.order_type || "subscription") === "adhoc") current.adhocItems.push(item)
    else current.dailyItems.push(item)
  }

  return sections
}

async function saveInboundMessage(vendorId, customerId, phone, type, content, mediaId) {
  try {
    await pool.query(`
      INSERT INTO messages (vendor_id, customer_id, phone, direction, message_type, content, media_id)
      VALUES ($1,$2,$3,'inbound',$4,$5,$6)
    `, [vendorId, customerId, phone, type, content || null, mediaId || null])
  } catch (e) {
    console.error("saveInboundMessage error:", e.message)
  }
}

async function getCustomer(phone) {
  const r = await pool.query("SELECT * FROM customers WHERE phone=$1", [phone])
  if (r.rows.length) return r.rows[0]
  return (await pool.query("INSERT INTO customers(phone) VALUES($1) RETURNING *", [phone])).rows[0]
}

async function getVendor(pid) {
  return (await pool.query("SELECT * FROM vendors WHERE phone_number_id=$1", [pid])).rows[0]
}

async function getSettings(vendorId) {
  const r = await pool.query("SELECT * FROM vendor_settings WHERE vendor_id=$1", [vendorId])
  return r.rows[0] || {}
}

async function getProfile(vendorId) {
  const r = await pool.query("SELECT * FROM vendor_profile WHERE vendor_id=$1", [vendorId])
  return r.rows[0] || {}
}

async function getSubscription(cId, vId) {
  return (await pool.query(
    "SELECT * FROM subscriptions WHERE customer_id=$1 AND vendor_id=$2",
    [cId, vId]
  )).rows[0] || null
}

async function getCustomerById(customerId) {
  if (!customerId) return null
  const r = await pool.query("SELECT * FROM customers WHERE customer_id=$1", [customerId])
  return r.rows[0] || null
}

async function getMenuContextByPhone(phone, vendorId) {
  if (!phone || !vendorId) {
    return { hasViewData: false, hasProductSubs: false, hasOrders: false, hasUpcomingAdhoc: false }
  }

  const customer = await getCustomer(phone)
  if (!customer?.customer_id) {
    return { hasViewData: false, hasProductSubs: false, hasOrders: false, hasUpcomingAdhoc: false }
  }

  const [prodSubsRes, ordersRes, adhocRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS cnt
       FROM customer_subscriptions
       WHERE customer_id=$1 AND vendor_id=$2 AND is_active=true AND quantity > 0`,
      [customer.customer_id, vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt
       FROM orders
       WHERE customer_id=$1 AND vendor_id=$2`,
      [customer.customer_id, vendorId]
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.customer_id=$1
         AND o.vendor_id=$2
         AND COALESCE(o.is_delivered, false)=false
         AND o.order_date >= $3
         AND oi.order_type='adhoc'`,
      [customer.customer_id, vendorId, getISTDateStr(1)]
    ),
  ])

  const hasProductSubs = parseInt(prodSubsRes.rows[0]?.cnt || 0, 10) > 0
  const hasOrders = parseInt(ordersRes.rows[0]?.cnt || 0, 10) > 0
  const hasUpcomingAdhoc = parseInt(adhocRes.rows[0]?.cnt || 0, 10) > 0

  return {
    hasProductSubs,
    hasOrders,
    hasUpcomingAdhoc,
    hasViewData: hasProductSubs || hasOrders,
  }
}

async function saveSubscription(cId, vId, qty) {
  await pool.query(`
    INSERT INTO subscriptions(customer_id, vendor_id, quantity, status)
    VALUES($1, $2, $3, 'active')
    ON CONFLICT(customer_id, vendor_id)
    DO UPDATE SET quantity=$3, status='active'
  `, [cId, vId, qty])
}

async function cleanupTodaySubscriptionOrders(cId, vId) {
  const today = getISTDateStr(0)
  await pool.query(`
    DELETE FROM order_items oi
    USING orders o
    WHERE oi.order_id = o.order_id
      AND o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND o.created_on::date = $3::date
      AND oi.order_type = 'subscription'
  `, [cId, vId, today])

  await pool.query(`
    DELETE FROM orders o
    WHERE o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND o.created_on::date = $3::date
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id
      )
  `, [cId, vId, today])
}

async function cleanupTodayAdhocOrders(cId, vId) {
  const today = getISTDateStr(0)
  await pool.query(`
    DELETE FROM order_items oi
    USING orders o
    WHERE oi.order_id = o.order_id
      AND o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND o.created_on::date = $3::date
      AND oi.order_type = 'adhoc'
  `, [cId, vId, today])

  await pool.query(`
    DELETE FROM orders o
    WHERE o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND o.created_on::date = $3::date
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id
      )
  `, [cId, vId, today])
}

async function replaceUpcomingAdhocOrder(cId, vId, orderDate, cart = []) {
  const existingOrderRes = await pool.query(`
    SELECT order_id
    FROM orders
    WHERE customer_id = $1
      AND vendor_id = $2
      AND order_date = $3::date
    LIMIT 1
  `, [cId, vId, orderDate])

  let orderId = existingOrderRes.rows[0]?.order_id || null

  if (orderId) {
    await pool.query(`
      DELETE FROM order_items
      WHERE order_id = $1
        AND order_type = 'adhoc'
    `, [orderId])

    const { rows: itemRows } = await pool.query(`
      SELECT 1
      FROM order_items
      WHERE order_id = $1
      LIMIT 1
    `, [orderId])

    if (itemRows.length === 0 && cart.length === 0) {
      await pool.query(`DELETE FROM orders WHERE order_id = $1`, [orderId])
      return null
    }
  }

  if (!orderId && cart.length > 0) {
    const { rows: orderRows } = await pool.query(`
      INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
      VALUES ($1,$2,$3,0)
      ON CONFLICT (customer_id, vendor_id, order_date)
      DO UPDATE SET quantity = orders.quantity
      RETURNING order_id
    `, [cId, vId, orderDate])
    orderId = orderRows[0].order_id
  }

  if (orderId && cart.length > 0) {
    for (const item of cart) {
      await pool.query(`
        INSERT INTO order_items
          (order_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
        VALUES ($1,$2,$3,$4,$5,'adhoc')
        ON CONFLICT (order_id, product_id, order_type)
        DO UPDATE SET quantity=$3, price_at_order=$4, delivery_charge_at_order=$5, order_type='adhoc'
      `, [orderId, item.product_id, item.qty, item.price, 0])
    }
  }

  if (orderId) {
    await refreshOrderTotals(orderId)
  }

  return orderId
}

async function getAddress(cId, vId) {
  const r = await pool.query(`
    SELECT cv.*, a.name AS apartment_name, b.block_name
    FROM customer_vendor_profile cv
    LEFT JOIN apartments a ON cv.apartment_id = a.apartment_id
    LEFT JOIN apartment_blocks b ON cv.block_id = b.block_id
    WHERE cv.customer_id=$1 AND cv.vendor_id=$2
  `, [cId, vId])
  return r.rows[0] || null
}

async function saveApartment(cId, vId, aptId, blockId, flat) {
  await pool.query(`
    INSERT INTO customer_vendor_profile
      (customer_id, vendor_id, address_type, apartment_id, block_id, flat_number, manual_address)
    VALUES ($1, $2, 'apartment', $3, $4, $5, NULL)
    ON CONFLICT(customer_id, vendor_id) DO UPDATE SET
      address_type='apartment', apartment_id=$3, block_id=$4, flat_number=$5, manual_address=NULL
  `, [cId, vId, aptId, blockId, flat])
}

async function saveManual(cId, vId, address) {
  await pool.query(`
    INSERT INTO customer_vendor_profile
      (customer_id, vendor_id, address_type, manual_address, apartment_id, block_id, flat_number)
    VALUES ($1, $2, 'house', $3, NULL, NULL, NULL)
    ON CONFLICT(customer_id, vendor_id) DO UPDATE SET
      address_type='house', manual_address=$3, apartment_id=NULL, block_id=NULL, flat_number=NULL
  `, [cId, vId, address])
}

async function getState(phone) {
  return (await pool.query("SELECT * FROM conversation_state WHERE phone=$1", [phone])).rows[0] || null
}

async function setState(phone, state, vendorId, temp = {}) {
  await pool.query(`
    INSERT INTO conversation_state(phone, state, selected_vendor_id, temp_data)
    VALUES($1, $2, $3, $4)
    ON CONFLICT(phone) DO UPDATE SET state=$2, selected_vendor_id=$3, temp_data=$4
  `, [phone, state, vendorId, temp])
}

/* --- INVOICE HELPERS ------------------------------------ */

function getInvoiceDateRange(period) {
  const now = getISTNow()
  const y   = now.getFullYear()
  const m   = now.getMonth()

  if (period === "this_month") {
    const from  = new Date(y, m, 1)
    const to    = new Date(y, m + 1, 0)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  if (period === "last_month") {
    const from  = new Date(y, m - 1, 1)
    const to    = new Date(y, m, 0)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  if (period === "last_7") {
    const to    = getISTNow(); to.setDate(to.getDate() - 1)
    const from  = new Date(to); from.setDate(to.getDate() - 6)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  if (period === "last_30") {
    const to    = getISTNow(); to.setDate(to.getDate() - 1)
    const from  = new Date(to); from.setDate(to.getDate() - 29)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  return null
}

async function buildAndSendInvoice(pid, phone, cId, vId, from, to) {
  const [custR, ordersR, itemsR, settingsR, profileR] = await Promise.all([
    pool.query(`
      SELECT c.customer_id, c.phone,
        CASE WHEN cv.address_type='apartment'
        THEN a.name || COALESCE(' - '||b.block_name,'') || COALESCE(' - Flat '||cv.flat_number,'')
        ELSE COALESCE(cv.manual_address,'') END AS address
      FROM customers c
      JOIN customer_vendor_profile cv ON cv.customer_id=c.customer_id AND cv.vendor_id=$2
      LEFT JOIN apartments a ON cv.apartment_id=a.apartment_id
      LEFT JOIN apartment_blocks b ON cv.block_id=b.block_id
      WHERE c.customer_id=$1
    `, [cId, vId]),
    pool.query(
      `SELECT order_id, order_date, quantity, is_delivered, delivery_charge_amount FROM orders
       WHERE customer_id=$1 AND vendor_id=$2
         AND order_date>=$3 AND order_date<=$4
       ORDER BY order_date`,
      [cId, vId, from, to]
    ),
    pool.query(
      `SELECT oi.order_id, oi.quantity, oi.price_at_order,
              oi.delivery_charge_at_order, oi.order_type, p.name AS product_name, p.unit
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       JOIN products p ON p.product_id = oi.product_id
       WHERE o.customer_id=$1 AND o.vendor_id=$2
         AND o.order_date>=$3 AND o.order_date<=$4 AND o.is_delivered=true`,
      [cId, vId, from, to]
    ),
    pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vId]),
    pool.query("SELECT business_name, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id=$1", [vId]),
  ])

  // Attach items to each order
  const itemsByOrder = {}
  for (const it of itemsR.rows) {
    if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = []
    itemsByOrder[it.order_id].push(it)
  }
  const ordersWithItems = ordersR.rows.map(o => ({ ...o, items: itemsByOrder[o.order_id] || [] }))

  const data = {
    customer:       custR.rows[0],
    orders:         ordersWithItems,
    price_per_unit: parseFloat(settingsR.rows[0]?.price_per_unit || 0),
    vendor:         profileR.rows[0] || {},
  }

  const delivered = data.orders.filter(o => o.is_delivered)
  if (delivered.length === 0) return false

  const pdfBuffer = await generateInvoicePDF(data, from, to)
  const filename  = `bill_${phone}_${from}_${to}.pdf`

  // Upload PDF to WhatsApp Media
  const blob     = new Blob([pdfBuffer], { type: "application/pdf" })
  const formData = new FormData()
  formData.append("file", blob, filename)
  formData.append("type", "application/pdf")
  formData.append("messaging_product", "whatsapp")

  const uploadRes  = await fetch(
    `https://graph.facebook.com/v21.0/${pid}/media`,
    { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: formData }
  )
  const uploadData = await uploadRes.json()
  if (!uploadRes.ok) throw new Error(uploadData.error?.message || "Media upload failed")

  // Send as document
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to:   phone,
    type: "document",
    document: {
      id:       uploadData.id,
      filename,
      caption: `Your milk bill (${displayDate(from)} – ${displayDate(to)})`
    }
  })

  return true
}

/* --- PAUSE HELPERS -------------------------------------- */

async function getActivePause(cId, vId) {
  const r = await pool.query(`
    SELECT * FROM subscription_pauses
    WHERE customer_id=$1 AND vendor_id=$2
      AND (pause_until IS NULL OR pause_until >= $3)
    ORDER BY pause_from DESC, pause_id DESC LIMIT 1
  `, [cId, vId, getISTDateStr(0)])
  return r.rows[0] || null
}

async function savePause(cId, vId, from, until) {
  await pool.query(
    `DELETE FROM subscription_pauses
     WHERE customer_id=$1 AND vendor_id=$2
       AND (pause_until IS NULL OR pause_until >= $3)`,
    [cId, vId, getISTDateStr(0)]
  )
  await pool.query(
    "INSERT INTO subscription_pauses(customer_id, vendor_id, pause_from, pause_until) VALUES($1,$2,$3,$4)",
    [cId, vId, from, until]
  )
}

async function removePausedOrders(cId, vId, from, until = null) {
  try {
    const ordersRes = await pool.query(
      `SELECT o.order_id, o.order_date, o.quantity,
              COALESCE(o.delivery_charge_amount, 0) AS delivery_charge_amount,
              COALESCE(o.payment_status, 'unpaid') AS payment_status
       FROM orders o
       WHERE o.customer_id=$1
         AND o.vendor_id=$2
         AND COALESCE(o.is_delivered, false)=false
         AND o.order_date >= $3
         AND ($4::date IS NULL OR o.order_date <= $4::date)`,
      [cId, vId, from, until]
    )

    const orderIds = []
    for (const order of ordersRes.rows) {
      const archiveRes = await pool.query(
        `INSERT INTO paused_orders_archive
           (customer_id, vendor_id, order_date, quantity, delivery_charge_amount, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, vendor_id, order_date)
         DO UPDATE SET
           quantity = EXCLUDED.quantity,
           delivery_charge_amount = EXCLUDED.delivery_charge_amount,
           payment_status = EXCLUDED.payment_status,
           archived_at = NOW()
         RETURNING archive_id`,
        [cId, vId, order.order_date, order.quantity, order.delivery_charge_amount, order.payment_status]
      )

      const archiveId = archiveRes.rows[0]?.archive_id
      if (!archiveId) continue

      await pool.query(`DELETE FROM paused_order_items_archive WHERE archive_id=$1`, [archiveId])
      await pool.query(
        `INSERT INTO paused_order_items_archive
           (archive_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
         SELECT $1, product_id, quantity, price_at_order, delivery_charge_at_order, order_type
         FROM order_items
         WHERE order_id=$2`,
        [archiveId, order.order_id]
      )

      orderIds.push(order.order_id)
    }

    if (!orderIds.length) return
    await pool.query(`DELETE FROM order_items WHERE order_id = ANY($1::int[])`, [orderIds])
    await pool.query(`DELETE FROM orders WHERE order_id = ANY($1::int[])`, [orderIds])
  } catch (e) {
    console.error("removePausedOrders archive fallback:", e.message)
  }
}

async function restorePausedOrders(cId, vId) {
  try {
    const today = getISTDateStr(0)
    const restored = { nextAdhocDate: null, adhocItems: [] }
    const archivesRes = await pool.query(
      `SELECT archive_id, order_date, quantity, delivery_charge_amount, payment_status
       FROM paused_orders_archive
       WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3
       ORDER BY order_date ASC, archive_id ASC`,
      [cId, vId, today]
    )

    for (const arch of archivesRes.rows) {
      const archivedItemsRes = await pool.query(
        `SELECT product_id, quantity, price_at_order, delivery_charge_at_order, order_type
         FROM paused_order_items_archive
         WHERE archive_id=$1`,
        [arch.archive_id]
      )
      if (!restored.nextAdhocDate) {
        const adhocItems = archivedItemsRes.rows.filter((item) => item.order_type === "adhoc")
        if (adhocItems.length) {
          restored.nextAdhocDate = arch.order_date
          restored.adhocItems = adhocItems
        }
      }

      const orderRes = await pool.query(
        `INSERT INTO orders
           (customer_id, vendor_id, order_date, quantity, delivery_charge_amount, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, vendor_id, order_date)
         DO UPDATE SET
           quantity = EXCLUDED.quantity,
           delivery_charge_amount = EXCLUDED.delivery_charge_amount,
           payment_status = EXCLUDED.payment_status
         WHERE COALESCE(orders.is_delivered, false) = false
         RETURNING order_id`,
        [cId, vId, arch.order_date, arch.quantity, arch.delivery_charge_amount, arch.payment_status]
      )

      const orderId = orderRes.rows[0]?.order_id
      if (!orderId) continue

      await pool.query(`DELETE FROM order_items WHERE order_id=$1`, [orderId])
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
         SELECT $1, product_id, quantity, price_at_order, delivery_charge_at_order, order_type
         FROM paused_order_items_archive
         WHERE archive_id=$2
         ON CONFLICT (order_id, product_id, order_type)
         DO UPDATE SET
           quantity = EXCLUDED.quantity,
           price_at_order = EXCLUDED.price_at_order,
           delivery_charge_at_order = EXCLUDED.delivery_charge_at_order,
           order_type = EXCLUDED.order_type`,
        [orderId, arch.archive_id]
      )

      await refreshOrderTotals(orderId)
    }

    await pool.query(
      `DELETE FROM paused_order_items_archive
       WHERE archive_id IN (
         SELECT archive_id FROM paused_orders_archive
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3
       )`,
      [cId, vId, today]
    )
    await pool.query(
      `DELETE FROM paused_orders_archive
       WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3`,
      [cId, vId, today]
    )
    return restored
  } catch (e) {
    console.error("restorePausedOrders error:", e.message)
    return { nextAdhocDate: null, adhocItems: [] }
  }
}

async function buildOrdersPlanText(cId, vId, withProducts, options = {}) {
  const {
    title = `\u{1F4CB} *Your daily subscription*`,
    restored = null,
    pause = null,
  } = options

  const addr = await getAddress(cId, vId)
  const sub = await getSubscription(cId, vId)
  const lines = []

  if (addr) lines.push(`\u{1F4CD} Your delivery address: ${formatAddress(addr)}`)
  if (title) lines.push(...(lines.length ? ["", title, ""] : [title, ""]))

  if (withProducts) {
    const prodSubs = await getCustomerProductSubs(cId, vId)
    const activeProdSubs = prodSubs.filter((s) => s.is_active && parseFloat(s.quantity || 0) > 0)
    if (activeProdSubs.length > 0) {
      activeProdSubs.forEach((s) => {
        const dailyCost = (parseFloat(s.price || 0) * parseFloat(s.quantity || 0)).toFixed(0)
        lines.push(`\u{1F4E6} *${s.name}${s.unit ? ` (${s.unit})` : ""}* — ${s.quantity}/day · Rs.${dailyCost}/day`)
      })
    } else {
      lines.push(`No active daily subscriptions.`)
    }
  } else if (sub) {
    lines.push(`Quantity: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}* per day`)
  } else {
    lines.push(`No active daily subscription.`)
  }

  const sections = await getUpcomingOrderSections(cId, vId)
  if (!sections.length && restored?.nextAdhocDate && restored?.adhocItems?.length) {
    sections.push({
      orderDate: restored.nextAdhocDate,
      deliveryCharge: 0,
      dailyItems: [],
      adhocItems: restored.adhocItems.map((item) => ({
        quantity: item.quantity,
        price_at_order: item.price_at_order,
        name: item.product_name || item.name || `Product #${item.product_id}`,
        unit: item.product_unit || item.unit || "",
      })),
    })
  }

  sections.forEach((section) => {
    lines.push("", `\u{1F4E6} *Upcoming Order for ${displayDate(section.orderDate)}:*`)
    section.dailyItems.forEach((item) => {
      const cost = (parseFloat(item.price_at_order || 0) * parseFloat(item.quantity || 0)).toFixed(0)
      lines.push(`• [Daily] ${item.name}${item.unit ? ` (${item.unit})` : ""} × ${item.quantity} — Rs.${cost}`)
    })
    section.adhocItems.forEach((item) => {
      const cost = (parseFloat(item.price_at_order || 0) * parseFloat(item.quantity || 0)).toFixed(0)
      lines.push(`• [Extra] ${item.name}${item.unit ? ` (${item.unit})` : ""} × ${item.quantity} — Rs.${cost}`)
    })
    lines.push(`\u{1F69A} Delivery — ${parseFloat(section.deliveryCharge || 0) > 0 ? `Rs.${parseFloat(section.deliveryCharge || 0).toFixed(2)}` : `Free`}`)
  })

  return lines.join("\n")
}

async function buildResumeSummary(cId, vId, withProducts, restored = null) {
  return buildOrdersPlanText(cId, vId, withProducts, { restored })
}

async function deletePause(pauseId) {
  await pool.query("DELETE FROM subscription_pauses WHERE pause_id=$1", [pauseId])
}

/* --- PAYMENT HELPERS ------------------------------------ */

async function downloadWhatsAppMedia(mediaId) {
  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    )
    const mediaUrl = metaRes.data.url
    const imgRes = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    })
    const filename = `pay_wa_${Date.now()}.jpg`
    const savePath = path.join(__dirname, "../public/uploads/payments", filename)
    if (!fs.existsSync(path.dirname(savePath))) fs.mkdirSync(path.dirname(savePath), { recursive: true })
    fs.writeFileSync(savePath, imgRes.data)
    return `/uploads/payments/${filename}`
  } catch (err) {
    console.error("Media download error:", err.message)
    return null
  }
}


/* --- MENU SENDERS --------------------------------------- */

async function sendMainMenu(pid, phone, sub, profile, pause = null, withProducts = false, showPrompt = false, promptText = null) {
  const name = (profile?.business_name || "Milk Service").trim()
  const vendorId = profile?.vendor_id || sub?.vendor_id || pause?.vendor_id || null

  // If customer has no address, only show Profile — all other features require it
  const addrCheck = await pool.query(
    `SELECT 1 FROM customer_vendor_profile cv
     JOIN customers c ON c.customer_id = cv.customer_id
     WHERE c.phone=$1 AND cv.vendor_id=$2 LIMIT 1`,
    [phone, vendorId]
  )
  if (addrCheck.rows.length === 0) {
    await sendList(pid, phone,
      `*${name}*\n\nPlease complete your profile setup to access all features.`,
      [{ id: "profile", title: "Profile", description: "Set up your delivery address" }],
      "View Options"
    )
    return
  }

  const menuCtx = await getMenuContextByPhone(phone, vendorId)
  const adhocMenuTitle = menuCtx.hasUpcomingAdhoc ? "Change Order Tomorrow" : "Order Tomorrow"
  const adhocMenuDesc = menuCtx.hasUpcomingAdhoc ? "Update your extra products for tomorrow" : "Order extra products for tomorrow"
  let header, rows

  if (!sub) {
    header = showPrompt ? `*${name}*\n\nHow can we help you today?` : `*${name}*`
    rows = []
    if (menuCtx.hasViewData) {
      rows.push({ id: "view", title: "View Orders & Plan", description: "View subscription and order details" })
    }
    if (withProducts) {
      rows.push(
        { id: "manage_products", title: "Daily Subscription", description: "Choose your daily delivery products" },
        { id: "adhoc_order",     title: adhocMenuTitle,       description: adhocMenuDesc },
        { id: "profile",         title: "Profile",         description: "View or update your details" }
      )
    } else {
      rows.push({ id: "profile", title: "Profile", description: "View or update your details" })
    }
  } else if (sub.status === "active" && pause) {
    const pauseDetails = pause.pause_until
      ? `*Daily products paused* from *${displayDate(pause.pause_from)}* to *${displayDate(pause.pause_until)}*.\nYour daily subscription deliveries are skipped during this period.\n_(Extra/adhoc orders are not affected)_`
      : `*Daily products paused* from *${displayDate(pause.pause_from)}* until you resume.\nYour daily subscription deliveries are paused until you resume.\n_(Extra/adhoc orders are not affected)_`
    const custRow = await pool.query("SELECT customer_id FROM customers WHERE phone=$1 LIMIT 1", [phone])
    const pauseCId = custRow.rows[0]?.customer_id
    const pauseSummary = pauseCId ? await buildResumeSummary(pauseCId, vendorId, withProducts).catch(() => null) : null
    const titleLine = promptText || `*${name}*`
    header = pauseSummary
      ? `${titleLine}\n\n${pauseDetails}\n\n${pauseSummary}`
      : `${titleLine}\n\n${pauseDetails}`
    rows = [
      { id: "resume_pause", title: "Resume Daily Orders", description: "End pause & restart daily delivery" },
      { id: "profile",      title: "Profile",             description: "View or update your details"       },
      { id: "get_invoice",  title: "Get Bill",            description: "Download your bill"               },
    ]
    if (withProducts) {
      rows.splice(1, 0, { id: "adhoc_order", title: adhocMenuTitle, description: adhocMenuDesc })
    }
  } else if (sub.status === "active") {
    header = showPrompt ? `*${name}*\n\nHow can we help you today?` : `*${name}*`
    rows = [
      { id: "view",        title: "View Orders & Plan", description: "View subscription and order details" },
      { id: "profile",     title: "Profile",           description: "View or update your details" },
      { id: "pause",       title: "Pause Delivery",     description: "Skip delivery for some days" },
      { id: "get_invoice", title: "Get Bill",          description: "Download your bill"          },
    ]
    if (withProducts) {
      rows.splice(1, 0, { id: "manage_products", title: "Change Daily Products", description: "Update your daily delivery products" })
      rows.splice(2, 0, { id: "adhoc_order",     title: adhocMenuTitle,          description: adhocMenuDesc })
      // Only show Pause if customer has active daily product subscriptions
      if (!menuCtx.hasProductSubs) {
        const pauseIdx = rows.findIndex(r => r.id === "pause")
        if (pauseIdx !== -1) rows.splice(pauseIdx, 1)
      }
    }
  } else {
    header = showPrompt ? `*${name}*\n\nHow can we help you today?` : `*${name}*`
    rows = []
    if (menuCtx.hasViewData) {
      rows.push({ id: "view", title: "View Orders & Plan", description: "View subscription and order details" })
    }
    rows.push(
      { id: "profile",     title: "Profile",           description: "View or update your details" },
      { id: "get_invoice", title: "Get Bill",          description: "Download your bill"       }
    )
    if (withProducts) {
      rows.unshift({ id: "adhoc_order",     title: adhocMenuTitle,  description: adhocMenuDesc })
      rows.unshift({ id: "manage_products", title: "Daily Subscription", description: "Choose your daily delivery products" })
    }
  }

  await sendList(pid, phone, header, rows, "View Options")
}

async function sendQtyMenu(pid, phone, prefix, maxQty = 5, price = 0) {
  const limit = Math.min(maxQty, 5)
  const rows = Array.from({ length: limit }, (_, i) => {
    const n = i + 1
    const priceStr = price > 0 ? ` · Rs.${price * n}/day` : ""
    return {
      id: `${prefix}_${n}`,
      title: `${n} Packet${n > 1 ? "s" : ""} — 500ml each`,
      description: `${n} × 500ml${priceStr}`
    }
  })
  rows.push({ id: `${prefix}_custom`, title: "Custom Packets", description: "Enter any number of packets" })
  await sendList(pid, phone, "*Select Daily Quantity*\n\nHow many milk packets per day?", nav(rows), "Choose")
}

async function sendPauseMenu(pid, phone) {
  await sendList(pid, phone,
    "*Pause Delivery*\n\nHow long would you like to pause your delivery?",
    [
      { id: "pause_1",   title: "1 Day",           description: "Skip tomorrow's delivery only" },
      { id: "pause_2",   title: "2 Days",           description: "Skip next 2 days"              },
      { id: "pause_3",   title: "3 Days",           description: "Skip next 3 days"              },
      { id: "pause_4",   title: "4 Days",           description: "Skip next 4 days"              },
      { id: "pause_5",   title: "5 Days",           description: "Skip next 5 days"              },
      { id: "pause_6",   title: "6 Days",           description: "Skip next 6 days"              },
      { id: "pause_7",   title: "1 Week",           description: "Skip next 7 days"              },
      { id: "pause_14",  title: "2 Weeks",          description: "Skip next 14 days"             },
      { id: "pause_30",  title: "1 Month",          description: "Skip next 30 days"             },
      { id: "pause_now", title: "Until I Resume", description: "No end date — resume manually" }
    ],
    "Select"
  )
}

async function sendApartmentMenu(pid, phone, vendorId) {
  const r = await pool.query(
    "SELECT * FROM apartments WHERE vendor_id=$1 AND is_active=true ORDER BY name",
    [vendorId]
  )
  if (r.rows.length === 0) return false
  await sendList(pid, phone,
    "*Select Your Apartment / Society*\n\nChoose from the list below:",
    nav(r.rows.map(x => ({ id: `apt_${x.apartment_id}`, title: x.name, description: x.address || "" }))),
    "Select"
  )
  return true
}

async function sendAdhocProductList(pid, phone, vendorId, cart = []) {
  const prods = await getVendorProducts(vendorId, "adhoc")
  const cartMap = {}
  cart.forEach(c => { cartMap[c.product_id] = c.qty })

  const rows = prods.map(p => {
    const inCart = cartMap[p.product_id]
    return {
      id:          `adhoc_${p.product_id}`,
      title:       `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24),
      description: (inCart
        ? `? In cart: ${inCart} × Rs.${(p.price * inCart).toFixed(0)}`
        : `Rs.${p.price}`
      ).slice(0, 72),
    }
  })

  const cartCount = cart.length
  const headerSuffix = cartCount > 0
    ? `\n\n*${cartCount} item${cartCount > 1 ? "s" : ""} in cart* — tap Place Order when ready`
    : `\n\nTap a product to add it to your order:`

  if (cartCount > 0) {
    rows.push({ id: "adhoc_place_order", title: "Place Order" })
  }
  rows.push({ id: "menu", title: "Main Menu" })

  await sendList(pid, phone,
    `*Order Tomorrow Products*${headerSuffix}`,
    rows, cartCount > 0 ? "Cart" : "Select"
  )
}

async function sendBlockMenu(pid, phone, aptId) {
  const r = await pool.query(
    "SELECT * FROM apartment_blocks WHERE apartment_id=$1 AND is_active=true ORDER BY block_name",
    [aptId]
  )
  if (r.rows.length === 0) return false
  await sendList(pid, phone,
    "*Select Your Block / Tower*",
    nav(r.rows.map(x => ({ id: `block_${x.block_id}`, title: x.block_name }))),
    "Select"
  )
  return true
}

/* --- ADDRESS FLOW --------------------------------------- */

async function startAddressFlow(pid, phone, customerId, vendor, afterAddr = false, existingAddr = null) {
  const bizName = (vendor.business_name || "MilkRoute").trim()
  const customer = await getCustomerById(customerId)
  const currentName = customer?.name || null
  let sent = false
  if (existingAddr || (!afterAddr && customerId)) {
    sent = await sendAddressUpdateFlow(
      pid,
      phone,
      vendor.vendor_id,
      customerId,
      bizName,
      currentName,
      existingAddr ? formatAddress(existingAddr) : null
    )
  } else {
    sent = await sendRegistrationFlow(pid, phone, vendor.vendor_id, customerId, bizName)
  }

  if (!sent) {
    await setState(phone, "menu", vendor.vendor_id)
    await sendText(pid, phone, "We could not open the profile form right now. Please try again in a moment or type menu to continue.")
    return
  }

  await setState(phone, "awaiting_registration", vendor.vendor_id, { after_addr: afterAddr })
}

async function confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts = false) {
  const settings = await getSettings(vId)
  if (!isOrderWindowOpen(settings, profile)) {
    const sub = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await sendOrderWindowClosedMessage(pid, phone, settings, profile)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
    return
  }
  await saveSubscription(cId, vId, qty)
  await cleanupTodaySubscriptionOrders(cId, vId)
  const addr  = await getAddress(cId, vId)
  const pause = await getActivePause(cId, vId)

  let confirm = `*Subscription Confirmed!*\n\n`
  confirm += `*${qty} packet${qty > 1 ? "s" : ""}* × 500ml delivered every day\n`
  if (price > 0) confirm += `Rs.${price * qty}/day\n`
  confirm += `${formatAddress(addr)}\n\nYour delivery will start tomorrow${profile?.delivery_start && profile?.delivery_end ? ` between ${formatTime12(profile.delivery_start)} and ${formatTime12(profile.delivery_end)}` : ""}.`

  await sendText(pid, phone, confirm)
  const s = await getSubscription(cId, vId)
  await setState(phone, "menu", vId)
  await sendMainMenu(pid, phone, s, profile, pause, withProducts)
}

async function afterAddressComplete(pid, phone, cId, vId, profile, settings, afterAddr, withProducts = false) {
  if (afterAddr) {
    const maxQty = settings.max_quantity_per_order || 5
    await sendQtyMenu(pid, phone, "sub", maxQty)
    await setState(phone, "sub_qty", vId)
  } else {
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
  }
}

/* --- MAIN HANDLER --------------------------------------- */

async function handleCustomerBot(msg, pid) {
  const phone = msg.from

  console.log("CustomerBot | phone:", phone, "| pid:", pid)

  const vendor = await getVendor(pid)
  if (!vendor) {
    console.log("No vendor found for phone_number_id:", pid)
    return
  }
  if (!vendor.is_active) {
    console.log("Vendor is inactive:", vendor.vendor_id)
    return
  }

  console.log("Vendor:", vendor.vendor_id, vendor.vendor_name || "")

  const customer = await getCustomer(phone)
  let state      = await getState(phone)
  const settings = await getSettings(vendor.vendor_id)
  const profile  = await getProfile(vendor.vendor_id)

  console.log("Customer:", customer.customer_id, "| State:", state?.state || "none")

  const withProducts = await hasVendorProducts(vendor.vendor_id)

  const vId = vendor.vendor_id
  const cId = customer.customer_id

  let input = null
  if (msg.type === "text")        input = msg.text?.body?.trim()
  if (msg.type === "interactive") input = msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id

  // -- Handle flow form submission --
  const isFlowReply = msg.type === "interactive" && msg.interactive?.type === "nfm_reply"
  if (isFlowReply) {
    const formData = JSON.parse(msg.interactive.nfm_reply.response_json || "{}")
    console.log("Product flow nfm_reply formData:", JSON.stringify(formData))
    const hasProductQtyKeys = Object.keys(formData || {}).some((key) => /^qty_\d+$/.test(key))
    const isTokenOnlyFlowReply = !!formData?.flow_token && Object.keys(formData || {}).length === 1

    // Once adhoc confirmation is already shown, later token-only flow replies are just noise.
    if (isTokenOnlyFlowReply && state?.state === "flow_adhoc_confirm") {
      console.log("Ignoring token-only product flow nfm_reply")
      return
    }

    // Product-list flow replies can arrive without the bot needing to process them here again.
    // Guard them so they are never misread as registration/address flow submissions.
    if (hasProductQtyKeys && state?.state !== "manage_products" && state?.state !== "adhoc_product") {
      console.log("Ignoring product flow nfm_reply outside product states")
      return
    }

    // Product List flow: detect from state OR from flow token (for flows sent directly from welcome/order-placed)
    const flowTokenMode = (formData?.flow_token || "").split(":")?.[2] // "sub" or "adhoc"
    const isProductListFlow = state?.state === "manage_products" || state?.state === "adhoc_product"
                           || flowTokenMode === "sub" || flowTokenMode === "adhoc"

    if (isProductListFlow) {
      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
        const sub = await getSubscription(cId, vId)
        const pause = await getActivePause(cId, vId)
        await setState(phone, "menu", vId)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const isAdhoc = state?.state === "adhoc_product" || flowTokenMode === "adhoc"

    if (isAdhoc) {
      // -- Adhoc: cart was saved by flow endpoint — show confirmation --
      const freshState = await getState(phone)
      const cart       = freshState?.temp_data?.flow_cart || []
      const adhocSubmitted = !!freshState?.temp_data?.flow_adhoc_submitted
      const policy     = await getVendorDeliveryPolicy(vId)
      const delCharge  = computeCartDeliveryCharge(cart, policy)

      if (cart.length === 0) {
        if (adhocSubmitted) {
          const tom = istTomorrowStr()
          await sendButtons(pid, phone,
            `*Update Tomorrow's Order*\n\nNo products selected for ${displayDate(tom)}.\n\nConfirm to remove the extra items from your upcoming order.`,
            [
              { id: "flow_confirm_order", title: "Confirm Update" },
              { id: "flow_cancel_order",  title: "Cancel"         },
            ]
          )
          await setState(phone, "flow_adhoc_confirm", vId, {
            flow_cart:            [],
            flow_delivery_charge: 0,
            flow_adhoc_submitted: true,
          })
          return
        }
        // Nothing entered in the flow — treat as cancel all adhoc orders
        const tom = istTomorrowStr()
        await sendButtons(pid, phone,
          `*Cancel Tomorrow's Order?*\n\nNo products were selected for ${displayDate(tom)}.\n\nConfirm to cancel all items from your upcoming order.`,
          [
            { id: "flow_confirm_order", title: "Cancel Orders" },
            { id: "flow_cancel_order",  title: "Keep Orders"   },
          ]
        )
        await setState(phone, "flow_adhoc_confirm", vId, {
          flow_cart:            [],
          flow_delivery_charge: 0,
          flow_adhoc_submitted: true,
        })
        return
        }

        const tom = istTomorrowStr()
        await sendButtons(pid, phone,
          buildCartOrderSummary(cart, delCharge, tom, profile),
          [
            { id: "flow_confirm_order", title: "Confirm Order" },
            { id: "flow_cancel_order",  title: "Cancel"        },
          ]
        )
        await setState(phone, "flow_adhoc_confirm", vId, {
          flow_cart:             cart,
          flow_delivery_charge:  delCharge,
          flow_adhoc_submitted:  adhocSubmitted,
        })
        return
      }

      // -- Subscription: was already saved by flow endpoint --
      const freshState = await getState(phone)
      const subSaved   = freshState?.temp_data?.flow_sub_saved
      const sub        = await getSubscription(cId, vId)
      const pause      = await getActivePause(cId, vId)
      const summary = await buildResumeSummary(cId, vId, withProducts)
      let confirmMsg
      if (subSaved && sub?.status === "inactive") {
        confirmMsg = `*Daily Orders Cancelled!*\n\nAll your daily product subscriptions have been set to 0. No daily deliveries will be scheduled.`
      } else if (subSaved) {
        confirmMsg = `*Products updated!*\n\n${summary || "Your daily subscriptions have been saved."}`
      } else {
        confirmMsg = `*No changes detected.*\n\n${summary || "Your subscriptions remain the same."}`
      }
      await sendText(pid, phone, confirmMsg)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Registration / address update flow
    const name = formData.customer_name || ""
    if (name) {
      await pool.query("UPDATE customers SET name=$1 WHERE customer_id=$2", [name, cId])
    }

    if (formData.address_type === "apartment") {
      await saveApartment(cId, vId, formData.apartment_id, formData.block_id, formData.flat_number)
    } else if (formData.address_type === "house") {
      await saveManual(cId, vId, formData.manual_address)
    }

    const isUpdate = !!(await getAddress(cId, vId)) && state?.state === "awaiting_registration" && state?.temp_data?.after_addr === false
    const confirmMsg = isUpdate
      ? `*Address updated!*\n\nYour delivery address has been saved.`
      : `*Registration complete!*\n\nWelcome${name ? `, ${name}` : ""}!\n\nYour address has been saved.`

    await sendText(pid, phone, confirmMsg)
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
    return
  }

  const MEDIA_STATES = ["payment_screenshot"]
  const MEDIA_TYPES  = ["image", "document", "audio", "video"]
  const isMedia      = MEDIA_TYPES.includes(msg.type)
  // Allow null input in payment_screenshot state (image) or when it's a capturable media message
  if (!input && !MEDIA_STATES.includes(state?.state) && !isMedia) return

  const inputLower = (input || "").toLowerCase()

  const resetToMainMenuWithSupportReply = async () => {
    // If customer has no address, save message + show support reply + then registration flow
    const addr = await getAddress(cId, vId)
    if (!addr) {
      // Save inbound message so vendor sees it
      let msgContent = null, msgType = "text", mediaId = null
      if (msg.type === "text") { msgContent = input || msg.text?.body?.trim() || null }
      else if (msg.type === "image")    { msgType = "image";    mediaId = msg.image?.id;    msgContent = msg.image?.caption || null }
      else if (msg.type === "document") { msgType = "document"; mediaId = msg.document?.id; msgContent = msg.document?.caption || null }
      else if (msg.type === "audio")    { msgType = "audio";    mediaId = msg.audio?.id }
      else if (msg.type === "video")    { msgType = "video";    mediaId = msg.video?.id;    msgContent = msg.video?.caption || null }
      if (msgContent || mediaId) await saveInboundMessage(vId, cId, phone, msgType, msgContent, mediaId)

      // Show support reply first
      const vendorPhone = profile.whatsapp_number || ""
      await sendText(pid, phone,
        vendorPhone
          ? `We received your message.\n\nFor immediate help, please call:\n*${vendorPhone}*`
          : `We received your message and will get back to you if needed.`
      )

      // Then show registration flow
      const bizName = (profile?.business_name || "MilkRoute").trim()
      await sendText(pid, phone,
        `Welcome to *${bizName}*!\n\nTo start receiving daily deliveries, please complete your account setup by tapping the button below.`
      )
      const sent = await sendRegistrationFlow(pid, phone, vId, cId, bizName)
      if (sent) {
        await setState(phone, "awaiting_registration", vId)
      } else {
        await setState(phone, "menu", vId)
        await sendText(pid, phone, "We could not open the profile form right now. Please try again in a moment.")
      }
      return
    }

    let msgContent = null
    let msgType = "text"
    let mediaId = null

    if (msg.type === "text") {
      msgContent = input || msg.text?.body?.trim() || null
    } else if (msg.type === "image") {
      msgType = "image"
      mediaId = msg.image?.id
      msgContent = msg.image?.caption || null
    } else if (msg.type === "document") {
      msgType = "document"
      mediaId = msg.document?.id
      msgContent = msg.document?.caption || null
    } else if (msg.type === "audio") {
      msgType = "audio"
      mediaId = msg.audio?.id
    } else if (msg.type === "video") {
      msgType = "video"
      mediaId = msg.video?.id
      msgContent = msg.video?.caption || null
    }

    if (msgContent || mediaId) {
      await saveInboundMessage(vId, cId, phone, msgType, msgContent, mediaId)
    }

    const vendorPhone = profile.whatsapp_number || ""
    await sendText(pid, phone,
      vendorPhone
        ? `We received your message.\n\nFor immediate help, please call:\n*${vendorPhone}*`
        : `We received your message and will get back to you if needed.`
    )

    const sub = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
  }

  /* -- Global: greetings and menu reset -- */

  const isReset   = ["hi", "hello", "start"].includes(inputLower)
  const isMenuNav = inputLower === "menu"

  if (!state || isReset || isMenuNav) {
    const sub   = await getSubscription(cId, vId)
    const addr  = await getAddress(cId, vId)
    const pause = await getActivePause(cId, vId)
    const name  = (profile?.business_name || "Milk Service").trim()
    let hasAnyActivity = false

    if (!state || isReset) {
      // -- New user with no address ? send registration flow --
      if (!addr && !sub) {
        const bizName = (profile?.business_name || "MilkRoute").trim()
        await sendText(pid, phone,
          `Welcome to *${bizName}*!\n\nTo start receiving daily deliveries, please complete your account setup by tapping the button below. It only takes a minute.`
        )
        const sent = await sendRegistrationFlow(pid, phone, vId, cId, bizName)
        if (sent) {
          await setState(phone, "awaiting_registration", vId)
        } else {
          await setState(phone, "menu", vId)
          await sendText(pid, phone, "We could not open the profile form right now. Please try again in a moment or type menu to continue.")
        }
        return
      }

      const menuCtxWelcome = await getMenuContextByPhone(phone, vId)
      hasAnyActivity = sub?.status === "active" || menuCtxWelcome.hasOrders || menuCtxWelcome.hasUpcomingAdhoc

      if (hasAnyActivity) {
        const summary = await buildResumeSummary(cId, vId, withProducts)
        await sendText(pid, phone, `*Welcome back!*\n\n${summary || formatAddress(addr)}`)
      } else {
        await sendText(pid, phone, `*Welcome to ${name}!*\n\nFresh milk & dairy products delivered to your doorstep. `)
      }

      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      }
    }

    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts, true, hasAnyActivity ? "*Welcome back!*" : null)
    return
  }

  /* -- Global: menu button tapped from any state -- */
  // WhatsApp lets customers tap buttons from old messages, so honour menu actions
  // regardless of the current conversation state.
  const MENU_ACTIONS = ["manage_products", "adhoc_order", "subscribe", "view", "change",
                        "profile", "get_invoice", "pause", "resume_pause", "resume"]
  const isButtonOrListReply = msg.type === "interactive" &&
    (msg.interactive?.type === "button_reply" || msg.interactive?.type === "list_reply")
  if (isButtonOrListReply && MENU_ACTIONS.includes(input) && state?.state !== "menu") {
    await setState(phone, "menu", vId)
    state = { ...state, state: "menu" }
  }

  /* -- Menu state -- */

  if (state.state === "menu") {
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)

    // -- Manage per-product subscriptions --
    if (input === "manage_products") {
      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const products = await getVendorProducts(vId, "subscription")
      if (products.length === 0) {
        await sendText(pid, phone, "No subscription products available right now. Please check back later.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      await sendProductListFlow(pid, phone, cId, vId,
        `*Daily Subscription Products*\n\nSet your daily quantity for each product below.`
      )
      await setState(phone, "manage_products", vId)
      return
    }

    // -- Adhoc / Quick Order --
    if (input === "adhoc_order") {
      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const products = await getVendorProducts(vId, "adhoc")
      if (products.length === 0) {
        await sendText(pid, phone, "No quick-order products available right now.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const tomorrow = istTomorrowStr()
      await sendProductListFlow(pid, phone, cId, vId,
        `*Order Tomorrow Products*\n\nEnter quantity for each product you want delivered on *${displayDate(tomorrow)}*.`,
        "adhoc"
      )
      await setState(phone, "adhoc_product", vId, { cart: [] })
      return
    }

    // Subscribe (new or re-subscribe)
    if (input === "subscribe") {
      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      if (!withProducts) {
        await sendText(pid, phone, "Daily products are not available for this vendor right now.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const addr = await getAddress(cId, vId)
      if (!addr) {
        await sendText(pid, phone, "*First, let's save your delivery address.*\n\nThis only takes a moment!")
        await startAddressFlow(pid, phone, cId, vendor, true)
        return
      }
      const maxQty = settings.max_quantity_per_order || 5
      const price  = settings.price_per_unit || 0
      await sendQtyMenu(pid, phone, "sub", maxQty, price)
      await setState(phone, "sub_qty", vId)
      return
    }

    // View subscription
    if (input === "view") {
      const prodSubs = withProducts ? await getCustomerProductSubs(cId, vId) : []
      const activeProdSubs = prodSubs.filter(s => s.is_active && parseFloat(s.quantity || 0) > 0)
      const hasViewData = !!sub || activeProdSubs.length > 0 || !!(await getMenuContextByPhone(phone, vId)).hasOrders

      if (!hasViewData) {
        await sendText(pid, phone, "You don’t have any subscription or order details yet.\n\nYou can subscribe to daily products or order products for tomorrow.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }

      const text = await buildOrdersPlanText(cId, vId, withProducts, { pause })
      await sendText(pid, phone, text)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Change quantity
    if (input === "change") {
      if (!isOrderWindowOpen(settings, profile)) {
        await sendOrderWindowClosedMessage(pid, phone, settings, profile)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      if (!withProducts) {
        await sendText(pid, phone, "Daily products are not available for this vendor right now.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const maxQty = settings.max_quantity_per_order || 5
      const price  = settings.price_per_unit || 0
      await sendQtyMenu(pid, phone, "chg", maxQty, price)
      await setState(phone, "chg_qty", vId)
      return
    }

    // Profile
    if (input === "profile") {
      const addr = await getAddress(cId, vId)
      await startAddressFlow(pid, phone, cId, vendor, false, addr || null)
      return
    }

    // Get invoice
    if (input === "get_invoice") {
      const now       = getISTNow()
      const thisMonth = now.toLocaleString("en-IN", { month: "long", year: "numeric" })
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
                          .toLocaleString("en-IN", { month: "long", year: "numeric" })
      await sendButtons(pid, phone,
        `*Get Bill*\n\nWhich month's bill do you need?\n\nThis Month: ${thisMonth}\nLast Month: ${lastMonth}`,
        [
          { id: "inv_this_month", title: "This Month" },
          { id: "inv_last_month", title: "Last Month"  },
        ]
      )
      await setState(phone, "invoice_period", vId)
      return
    }

    // Pause delivery
    if (input === "pause") {
      await sendPauseMenu(pid, phone)
      await setState(phone, "pause_select", vId)
      return
    }

    // Resume from pause (customer has active pause)
    if (input === "resume_pause") {
      if (pause) await deletePause(pause.pause_id)
      const restored = await restorePausedOrders(cId, vId)
      await generateOrdersForVendor(vId, { includeToday: false, includeTomorrow: true })
      const resumeSummary = await buildResumeSummary(cId, vId, withProducts, restored)
      await sendText(
        pid,
        phone,
        `*Delivery Resumed!*\n\n${resumeSummary || "Your daily delivery has been restored from tomorrow."}\n\nSee you tomorrow! `
      )
      const s = await getSubscription(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, null, withProducts)
      return
    }

    // Resume inactive subscription
    if (input === "resume") {
      if (!withProducts) {
        await sendText(pid, phone, "Daily products are not available for this vendor right now.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      await pool.query(
        "UPDATE subscriptions SET status='active' WHERE customer_id=$1 AND vendor_id=$2",
        [cId, vId]
      )
      const addr = await getAddress(cId, vId)
      const qty  = sub?.quantity || 1
      await sendText(pid, phone, `*Delivery Resumed!*\n\n${qty} packet${qty > 1 ? "s" : ""}/day will be delivered to:\n${formatAddress(addr)}\n\nSee you tomorrow! `)
      const s = await getSubscription(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, null, withProducts)
      return
    }

    // Unrecognised input in menu state ? save to inbox + auto-reply
    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Quantity selection -- */

  if (state.state === "sub_qty" || state.state === "chg_qty") {
    const prefix = state.state === "sub_qty" ? "sub" : "chg"
    const maxQty = settings.max_quantity_per_order || 5
    const price  = settings.price_per_unit || 0

    // Custom option selected — ask user to type a number
    if (input === `${prefix}_custom`) {
      await sendText(pid, phone, `*Enter Number of Packets*\n\nType how many packets you want per day:\n(e.g. *6*, *8*, *10*)`)
      await setState(phone, "custom_qty", vId, { prefix })
      return
    }

    const parts = input.split("_")
    const qty   = parseInt(parts[parts.length - 1])

    if (isNaN(qty) || qty < 1) {
      await resetToMainMenuWithSupportReply()
      return
    }

    await confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts)
    return
  }

  /* -- Custom quantity text input -- */

  if (state.state === "custom_qty") {
    const qty    = parseInt(input.trim())
    const price  = settings.price_per_unit || 0
    const maxQty = settings.max_quantity_per_order || 0

    if (isNaN(qty) || !/^\d+$/.test(input.trim())) {
      await resetToMainMenuWithSupportReply()
      return
    }
    if (qty < 1) {
      await sendText(pid, phone, "Minimum is 1 packet. Please enter a valid number:")
      return
    }
    if (maxQty > 0 && qty > maxQty) {
      await sendText(pid, phone, `Maximum allowed is *${maxQty} packets* per day. Please enter a smaller number:`)
      return
    }

    await confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts)
    return
  }

  /* -- Pause selection -- */

  if (state.state === "pause_select") {
    const today    = getISTNow(); today.setHours(0, 0, 0, 0)
    const tomorrow = addDays(today, 1)

    const dayMatch = input.match(/^pause_(\d+)$/)
    if (dayMatch) {
      const days  = parseInt(dayMatch[1])
      const from  = dateToStr(tomorrow)
      const until = dateToStr(addDays(tomorrow, days - 1))
      await savePause(cId, vId, from, until)
      await removePausedOrders(cId, vId, from, until)
      const summary = await buildResumeSummary(cId, vId, withProducts)
      await sendText(pid, phone,
        `*Daily Delivery Paused*\n\nYour daily subscription products are paused from *${displayDate(from)}* to *${displayDate(until)}*.\n\n_Extra/adhoc orders are not affected — you can still place quick orders during this period._` +
        (summary ? `\n\n${summary}` : "")
      )
      const s = await getSubscription(cId, vId)
      const p = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, p, withProducts)
      return
    }

    if (input === "pause_now") {
      const from = dateToStr(tomorrow)
      await savePause(cId, vId, from, null)
      await removePausedOrders(cId, vId, from, null)
      const summary = await buildResumeSummary(cId, vId, withProducts)
      await sendText(pid, phone,
        `*Daily Delivery Paused*\n\nYour daily subscription products are paused from *${displayDate(from)}* until you resume.\n\n_Extra/adhoc orders are not affected — you can still place quick orders during this period._` +
        (summary ? `\n\n${summary}` : "")
      )
      const s = await getSubscription(cId, vId)
      const p = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, p, withProducts)
      return
    }

    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Address type selection -- */

  if (state.state === "addr_type") {
    const afterAddr = state.temp_data?.after_addr || false
    const temp = { after_addr: afterAddr }

    if (input === "apt") {
      const ok = await sendApartmentMenu(pid, phone, vId)
      if (ok) await setState(phone, "apt", vId, temp)
      else {
        await sendText(pid, phone, "No apartments available right now. Please try house address or contact support.")
        await setState(phone, "menu", vId)
      }
    } else if (input === "house") {
      await sendText(pid, phone, "*Enter Your Delivery Address*\n\nType your full house address\n(e.g. 12, Rose Street, Sector 5):")
      await setState(phone, "manual", vId, temp)
    } else {
      await resetToMainMenuWithSupportReply()
    }
    return
  }

  /* -- Apartment selection -- */

  if (state.state === "apt") {
    if (!input.startsWith("apt_")) {
      await resetToMainMenuWithSupportReply()
      return
    }
    const aptId       = input.split("_")[1]
    const afterAddr   = state.temp_data?.after_addr || false
    const temp        = { after_addr: afterAddr, aptId }
    const allowBlocks = settings.allow_blocks !== false

    if (allowBlocks) {
      const hasBlocks = await sendBlockMenu(pid, phone, aptId)
      if (hasBlocks) {
        await setState(phone, "block", vId, temp)
      } else {
        await sendText(pid, phone, "*Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
        await setState(phone, "flat", vId, { ...temp, blockId: null })
      }
    } else {
      await sendText(pid, phone, "*Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
      await setState(phone, "flat", vId, { ...temp, blockId: null })
    }
    return
  }

  /* -- Block selection -- */

  if (state.state === "block") {
    if (!input.startsWith("block_")) {
      await resetToMainMenuWithSupportReply()
      return
    }
    const blockId     = input.split("_")[1]
    const temp        = { ...state.temp_data, blockId }
    const requireFlat = settings.require_flat_number !== false

    if (requireFlat) {
      await sendText(pid, phone, "*Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
      await setState(phone, "flat", vId, temp)
    } else {
      await saveApartment(cId, vId, temp.aptId, blockId, null)
      await sendText(pid, phone, "*Address Saved!*\n\nYour delivery address has been updated.")
      await afterAddressComplete(pid, phone, cId, vId, profile, settings, temp.after_addr, withProducts)
    }
    return
  }

  /* -- Flat number entry -- */

  if (state.state === "flat") {
    const flat = input.trim()
    if (!flat || flat.length > 20) {
      await sendText(pid, phone, "Please enter a valid flat number (e.g. A-101, 304, Ground Floor)")
      return
    }
    const t = state.temp_data || {}
    await saveApartment(cId, vId, t.aptId, t.blockId, flat)
    await sendText(pid, phone, "*Address Saved!*\n\nYour delivery address has been updated.")
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, t.after_addr, withProducts)
    return
  }

  /* -- Manual house address -- */

  if (state.state === "manual") {
    const address = input.trim()
    if (address.length < 5) {
      await sendText(pid, phone, "Please enter a complete address (at least 5 characters).")
      return
    }
    if (address.length > 200) {
      await sendText(pid, phone, "Address too long. Please keep it under 200 characters.")
      return
    }
    await saveManual(cId, vId, address)
    await sendText(pid, phone, "*Address Saved!*\n\nYour delivery address has been updated.")
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, state.temp_data?.after_addr, withProducts)
    return
  }

  /* -- Bill period selection ? send PDF + summary + Mark as Paid option -- */

  if (state.state === "invoice_period") {
    const periodMap = {
      inv_this_month: { key: "this_month", label: "This Month" },
      inv_last_month: { key: "last_month", label: "Last Month" },
    }
    const entry = periodMap[input]
    if (!entry) {
      await resetToMainMenuWithSupportReply()
      return
    }

    const range = getInvoiceDateRange(entry.key)
    await sendText(pid, phone, `Generating your bill, please wait...`)

    // Calculate totals — use order_items if available, else fall back to quantity × price_per_unit
    const [deliveredR, itemsTotalR, itemsUnpaidR, settingsR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS cnt FROM orders
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4 AND is_delivered=true`,
        [cId, vId, range.from, range.to]
      ),
      pool.query(
        `SELECT COALESCE(SUM(order_total), 0) AS total
         FROM (
           SELECT o.order_id,
                  COALESCE(SUM(oi.quantity * oi.price_at_order), 0)
                  + CASE
                      WHEN COALESCE(MAX(o.delivery_charge_amount), 0) > 0 THEN COALESCE(MAX(o.delivery_charge_amount), 0)
                      ELSE COALESCE(SUM(oi.delivery_charge_at_order), 0)
                    END AS order_total
           FROM orders o
           LEFT JOIN order_items oi ON oi.order_id = o.order_id
           WHERE o.customer_id=$1 AND o.vendor_id=$2 AND o.order_date>=$3 AND o.order_date<=$4 AND o.is_delivered=true
           GROUP BY o.order_id
         ) totals`,
        [cId, vId, range.from, range.to]
      ),
      pool.query(
        `SELECT COALESCE(SUM(order_total), 0) AS total
         FROM (
           SELECT o.order_id,
                  COALESCE(SUM(oi.quantity * oi.price_at_order), 0)
                  + CASE
                      WHEN COALESCE(MAX(o.delivery_charge_amount), 0) > 0 THEN COALESCE(MAX(o.delivery_charge_amount), 0)
                      ELSE COALESCE(SUM(oi.delivery_charge_at_order), 0)
                    END AS order_total
           FROM orders o
           LEFT JOIN order_items oi ON oi.order_id = o.order_id
           WHERE o.customer_id=$1 AND o.vendor_id=$2 AND o.order_date>=$3 AND o.order_date<=$4
             AND o.is_delivered=true AND COALESCE(o.payment_status,'unpaid')='unpaid'
           GROUP BY o.order_id
         ) totals`,
        [cId, vId, range.from, range.to]
      ),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vId]),
    ])

    const totalDelivered = parseInt(deliveredR.rows[0].cnt)
    const itemsTotal     = parseFloat(itemsTotalR.rows[0].total)
    const itemsUnpaid    = parseFloat(itemsUnpaidR.rows[0].total)
    const pricePerUnit   = parseFloat(settingsR.rows[0]?.price_per_unit || 0)

    // Use order_items total if available, else legacy calculation
    const hasItemsData = itemsTotal > 0
    let totalAmount, unpaidAmount
    if (hasItemsData) {
      totalAmount  = itemsTotal
      unpaidAmount = itemsUnpaid
    } else {
      // Legacy: need qty for calculation
      const [allQtyR, unpaidQtyR] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(quantity),0) AS qty FROM orders WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4 AND is_delivered=true`, [cId, vId, range.from, range.to]),
        pool.query(`SELECT COALESCE(SUM(quantity),0) AS qty FROM orders WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4 AND is_delivered=true AND COALESCE(payment_status,'unpaid')='unpaid'`, [cId, vId, range.from, range.to]),
      ])
      totalAmount  = parseInt(allQtyR.rows[0].qty) * pricePerUnit
      unpaidAmount = parseInt(unpaidQtyR.rows[0].qty) * pricePerUnit
    }

    if (totalDelivered === 0) {
      await sendText(pid, phone, `No delivered orders found for this period.\n\nIf you think this is wrong, please contact your vendor.`)
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Send PDF
    try {
      await buildAndSendInvoice(pid, phone, cId, vId, range.from, range.to)
    } catch (err) {
      console.error("Invoice send error:", err.message)
      await sendText(pid, phone, `Sorry, we couldn't generate your bill right now. Please try again later.`)
      await setState(phone, "menu", vId)
      return
    }

    // All already paid
    if (unpaidAmount <= 0) {
      await sendText(pid, phone,
        `*Bill - ${entry.label}*\n\n` +
        `${displayDate(range.from)} to ${displayDate(range.to)}\n` +
        `Total: Rs.${totalAmount.toFixed(2)}\n\n` +
        `*This bill is fully paid!* Thank you.`
      )
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Some or all unpaid
    await sendButtons(pid, phone,
      `*Bill - ${entry.label}*\n\n` +
      `${displayDate(range.from)} to ${displayDate(range.to)}\n` +
      `Total: Rs.${totalAmount.toFixed(2)}\n` +
      `*Amount Due: Rs.${unpaidAmount.toFixed(2)}*\n\n` +
      `Already paid? Tap *Mark as Paid* and we'll record it.`,
      [
        { id: "confirm_pay", title: "Mark as Paid" },
        { id: "menu",        title: "Main Menu"   },
      ]
    )
    await setState(phone, "pay_confirm", vId, {
      totalAmount:  unpaidAmount,
      periodLabel:  entry.label,
      periodFrom:   range.from,
      periodTo:     range.to,
    })
    return
  }

  /* -- Mark as Paid confirmed ? ask screenshot only -- */

  if (state.state === "pay_confirm") {
    if (input !== "confirm_pay") {
      await resetToMainMenuWithSupportReply()
      return
    }

    await setState(phone, "payment_screenshot", vId, state.temp_data)
    if (settings.payment_proof_required) {
      await sendText(pid, phone, `*Payment Screenshot*\n\nPlease send a screenshot of your payment for our records.`)
    } else {
      await sendButtons(pid, phone,
        `*Payment Screenshot*\n\nSend a screenshot of your payment for our records, or tap Skip.`,
        [{ id: "skip_screenshot", title: "Skip" }]
      )
    }
    return
  }

  /* -- Payment screenshot (image or "skip") -- */

  if (state.state === "payment_screenshot") {
    const { totalAmount, periodLabel, periodFrom, periodTo } = state.temp_data || {}
    let screenshotUrl = null

    const isSkip = input === "skip_screenshot" || inputLower === "skip"
    const requiresProof = !!settings.payment_proof_required

    if (msg.type === "image" && msg.image?.id) {
      screenshotUrl = await downloadWhatsAppMedia(msg.image.id)
    } else if (requiresProof && isSkip) {
      await sendText(pid, phone, "Payment proof is required for this vendor. Please send a screenshot image to continue.")
      return
    } else if (!isSkip) {
      if (requiresProof) {
        await sendText(pid, phone, "Please send a payment screenshot image to continue.")
      } else {
        await sendButtons(pid, phone,
          "Please send a screenshot image, or tap Skip to continue without one.",
          [{ id: "skip_screenshot", title: "Skip" }]
        )
      }
      return
    }

    // Record payment with period
    await pool.query(`
      INSERT INTO payments
        (customer_id, vendor_id, amount, payment_method, screenshot_url,
         recorded_by, payment_date, period_from, period_to)
      VALUES ($1,$2,$3,'other',$4,'customer',$5,$6,$7)
    `, [cId, vId, totalAmount || 0, screenshotUrl, getISTDateStr(0), periodFrom || null, periodTo || null])

    // Mark covered orders as paid
    if (periodFrom && periodTo) {
      await pool.query(`
        UPDATE orders SET payment_status='paid'
        WHERE customer_id=$1 AND vendor_id=$2
          AND order_date>=$3 AND order_date<=$4
          AND is_delivered=true AND COALESCE(payment_status,'unpaid')='unpaid'
      `, [cId, vId, periodFrom, periodTo])
    }

      await sendText(pid, phone,
        `*Payment Recorded!*\n\n` +
        `${periodLabel ? `Period: ${periodLabel}\n` : ""}` +
        `Amount: Rs.${Number(totalAmount || 0).toFixed(2)}\n\n` +
        `Thank you! Your vendor has been notified. `
      )
      await setState(phone, "menu", vId)
      const sub = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

  /* -- Flow adhoc order: confirmation step -- */

  if (state.state === "flow_adhoc_confirm") {
    const cart      = state.temp_data?.flow_cart || []
    const adhocSubmitted = !!state.temp_data?.flow_adhoc_submitted
    const policy    = await getVendorDeliveryPolicy(vId)
    const delCharge = computeCartDeliveryCharge(cart, policy)

    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    if (input === "flow_cancel_order") {
      await sendText(pid, phone, "*Order cancelled.* No order has been placed.")
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    if (input === "flow_confirm_order") {
      if (cart.length === 0 && !adhocSubmitted) {
        const sub   = await getSubscription(cId, vId)
        const pause = await getActivePause(cId, vId)
        await setState(phone, "menu", vId)
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }

      const tomorrow = istTomorrowStr()
      await cleanupTodayAdhocOrders(cId, vId)
      await replaceUpcomingAdhocOrder(cId, vId, tomorrow, cart)

      const timingLine = formatDeliveryWindow(profile)

      const summary = await buildResumeSummary(cId, vId, withProducts)
      if (cart.length === 0) {
        await sendText(pid, phone, `*Orders Cancelled!*\n\nYour adhoc order for ${displayDate(tomorrow)} has been removed.`)
      } else {
        await sendText(pid, phone,
          `*Order Placed!*\n\n${summary}\n\n` +
          `Your order will be delivered tomorrow${timingLine ? ` between ${formatTime12(profile.delivery_start)} and ${formatTime12(profile.delivery_end)}` : ""}.\nDelivery Date: ${displayDate(tomorrow)}\n\nThank you!`
        )
      }

      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts, false, cart.length > 0 ? "*Order Placed!*" : null)
      return
    }

    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Manage per-product subscriptions: product selected -- */

  if (state.state === "manage_products") {
    if (input === "menu") {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    if (input?.startsWith("prd_")) {
      const productId = parseInt(input.split("_")[1])
      const prods = await getVendorProducts(vId, "subscription")
      const product = prods.find(p => p.product_id === productId)
      if (!product) {
        await sendText(pid, phone, "Product not found. Please try again.")
        return
      }
      const customerSubs = await getCustomerProductSubs(cId, vId)
      const current = customerSubs.find(s => s.product_id === productId)
      const currentQty = (current && current.is_active) ? current.quantity : 0

      const priceInfo = `Rs.${product.price}`
      const currentInfo = currentQty > 0
        ? `Currently: *${currentQty}/day* (Rs.${(product.price * currentQty).toFixed(0)}/day)`
        : `Currently: *not subscribed*`

      await sendText(pid, phone,
        `*${product.name}${product.unit ? ` (${product.unit})` : ""}*\n\n` +
        `${currentInfo}\nPrice: ${priceInfo}\n\n` +
        `How many do you want per day?\nEnter *0* to unsubscribe.\n(e.g. 1, 2, 3…)`
      )
      await setState(phone, "product_qty", vId, {
        product_id:      productId,
        product_name:    product.name,
        product_unit:    product.unit,
        price:           product.price,
        delivery_charge: 0,
      })
      return
    }

    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Product quantity entry (subscription management) -- */

  if (state.state === "product_qty") {
    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }
    const qty = parseInt((input || "").trim())
    if (isNaN(qty) || qty < 0) {
      await resetToMainMenuWithSupportReply()
      return
    }

    const { product_id, product_name, product_unit, price } = state.temp_data || {}

    if (qty === 0) {
      // Deactivate this product subscription
      await pool.query(`
        UPDATE customer_subscriptions SET is_active=false
        WHERE customer_id=$1 AND vendor_id=$2 AND product_id=$3
      `, [cId, vId, product_id])
      await sendText(pid, phone,
        `*${product_name}${product_unit ? ` (${product_unit})` : ""}* removed from your daily order.`
      )
    } else {
      // Upsert product subscription
      await pool.query(`
        INSERT INTO customer_subscriptions (customer_id, vendor_id, product_id, quantity, is_active)
        VALUES ($1,$2,$3,$4,true)
        ON CONFLICT (customer_id, product_id) DO UPDATE SET quantity=$4, is_active=true
      `, [cId, vId, product_id, qty])

      // Ensure base subscription is active
      await pool.query(`
        INSERT INTO subscriptions (customer_id, vendor_id, quantity, status)
        VALUES ($1,$2,$3,'active')
        ON CONFLICT (customer_id, vendor_id) DO UPDATE SET status='active'
      `, [cId, vId, qty])

      const dailyCost = (parseFloat(price) * qty).toFixed(0)
      await sendText(pid, phone,
        `*${product_name}${product_unit ? ` (${product_unit})` : ""}* — *${qty}/day*\n` +
        `Rs.${dailyCost}/day\n\nDelivery starts tomorrow! `
      )
    }

    // Go back to manage products view
    const products = await getVendorProducts(vId, "subscription")
    const customerSubs = await getCustomerProductSubs(cId, vId)
    const subMap = {}
    customerSubs.forEach(s => { subMap[s.product_id] = s })
    const rows = products.map(p => {
      const cs = subMap[p.product_id]
      const status = (cs && cs.is_active) ? `${cs.quantity}/day` : `Not subscribed`
      return { id: `prd_${p.product_id}`, title: `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24), description: status }
    })
    rows.push({ id: "menu", title: "Main Menu" })
    await sendList(pid, phone, `*Your Products Updated!*\n\nTap another product to manage it:`, rows, "Manage")
    await setState(phone, "manage_products", vId)
    return
  }

  /* -- Adhoc: product list (cart-based multi-select) -- */

  if (state.state === "adhoc_product") {
    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }
    const cart = state.temp_data?.cart || []

    if (input === "menu") {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // "Place Order" — confirm everything in cart
    if (input === "adhoc_place_order") {
      const policy = await getVendorDeliveryPolicy(vId)
      const deliveryCharge = computeCartDeliveryCharge(cart, policy)
      if (cart.length === 0) {
        await sendText(pid, phone, "Your cart is empty. Please select a product first.")
        return
      }
      const tomorrow = getISTDateStr(1)
      await sendButtons(pid, phone,
        buildCartOrderSummary(cart, deliveryCharge, tomorrow, profile),
        [
          { id: "adhoc_confirm", title: "Confirm Order" },
          { id: "adhoc_more",    title: "Add More"      },
        ]
      )
      await setState(phone, "adhoc_confirm", vId, { cart })
      return
    }

    if (input?.startsWith("adhoc_")) {
      const productId = parseInt(input.split("_")[1])
      const prods = await getVendorProducts(vId, "adhoc")
      const product = prods.find(p => p.product_id === productId)
      if (!product) { await sendText(pid, phone, "Product not found."); return }

      await sendText(pid, phone,
        `*${product.name}${product.unit ? ` (${product.unit})` : ""}*\n` +
        `Rs.${product.price}\n\n` +
        `How many? (enter a number, e.g. 1, 2, 3)`
      )
      await setState(phone, "adhoc_qty", vId, {
        cart,
        product_id:      productId,
        product_name:    product.name,
        product_unit:    product.unit || "",
        price:           parseFloat(product.price),
        delivery_charge: 0,
      })
      return
    }

    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Adhoc: quantity entry -- */

  if (state.state === "adhoc_qty") {
    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }
    const qty = parseInt((input || "").trim())
    if (isNaN(qty) || qty < 1) {
      await resetToMainMenuWithSupportReply()
      return
    }
    if (qty > 50) {
      await sendText(pid, phone, "Maximum 50 per item. Please enter a smaller number.")
      return
    }

    const { product_id, product_name, product_unit, price, delivery_charge } = state.temp_data || {}
    let cart = [...(state.temp_data?.cart || [])]

    // Merge with existing cart item for same product
    const existing = cart.findIndex(c => c.product_id === product_id)
    if (existing >= 0) {
      cart[existing] = { ...cart[existing], qty }
    } else {
      cart.push({ product_id, product_name, product_unit, price, delivery_charge, qty })
    }

    // Show updated cart + options
    const cartLines = cart.map(item =>
      `• ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} × ${item.qty}`
    ).join("\n")

    await sendButtons(pid, phone,
      `*Cart Updated!*\n\n${cartLines}\n\nDo you want to add more items or place the order?`,
      [
        { id: "adhoc_place_order", title: "Place Order" },
        { id: "adhoc_add_more",    title: "Add More"    },
      ]
    )
    await setState(phone, "adhoc_cart", vId, { cart })
    return
  }

  /* -- Adhoc: cart view (after adding item) -- */

  if (state.state === "adhoc_cart") {
    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }
    const cart = state.temp_data?.cart || []

    if (input === "adhoc_add_more" || input === "adhoc_more") {
      await sendAdhocProductList(pid, phone, vId, cart)
      await setState(phone, "adhoc_product", vId, { cart })
      return
    }

    if (input === "adhoc_place_order") {
      const policy = await getVendorDeliveryPolicy(vId)
      const deliveryCharge = computeCartDeliveryCharge(cart, policy)
      const tomorrow = getISTDateStr(1)
      await sendButtons(pid, phone,
        buildCartOrderSummary(cart, deliveryCharge, tomorrow, profile),
        [
          { id: "adhoc_confirm", title: "Confirm Order" },
          { id: "adhoc_more",    title: "Add More"      },
        ]
      )
      await setState(phone, "adhoc_confirm", vId, { cart })
      return
    }

    await resetToMainMenuWithSupportReply()
    return
  }

  /* -- Adhoc: order confirmation -- */

  if (state.state === "adhoc_confirm") {
    if (!isOrderWindowOpen(settings, profile)) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await sendOrderWindowClosedMessage(pid, phone, settings, profile)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }
    const cart = state.temp_data?.cart || []

    if (input === "adhoc_more" || input === "adhoc_add_more") {
      await sendAdhocProductList(pid, phone, vId, cart)
      await setState(phone, "adhoc_product", vId, { cart })
      return
    }

    if (input !== "adhoc_confirm") {
      await resetToMainMenuWithSupportReply()
      return
    }

    if (cart.length === 0) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    const tomorrow = istTomorrowStr()
    await cleanupTodayAdhocOrders(cId, vId)
    const orderId = await replaceUpcomingAdhocOrder(cId, vId, tomorrow, cart)

    const addr      = await getAddress(cId, vId)
    const orderAfterRows = orderId
      ? (await pool.query("SELECT delivery_charge_amount FROM orders WHERE order_id = $1", [orderId])).rows
      : []
    const orderDelivery = parseFloat(orderAfterRows[0]?.delivery_charge_amount || 0)
    const timingLine = formatDeliveryWindow(profile)

    const summary = await buildResumeSummary(cId, vId, withProducts)
    const successText = summary
      ? `*Order Placed!*\n\n${summary}\n\nYour order will be delivered tomorrow${timingLine ? ` between ${formatTime12(profile.delivery_start)} and ${formatTime12(profile.delivery_end)}` : ""}.\nDelivery Date: ${displayDate(tomorrow)}\n\nThank you!`
      : buildPlacedOrderFallback(cart, orderDelivery, tomorrow, addr, profile)
    await sendText(pid, phone, successText)

    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts, false, "*Order Placed!*")
    return
  }

  /* -- Fallback: capture unhandled message → auto-reply -- */

  // Save inbound message to inbox
  let msgContent = null, msgType = "text", mediaId = null
  if (msg.type === "text")          { msgContent = msg.text?.body }
  else if (msg.type === "image")    { msgType = "image";    mediaId = msg.image?.id;    msgContent = msg.image?.caption }
  else if (msg.type === "document") { msgType = "document"; mediaId = msg.document?.id; msgContent = msg.document?.caption }
  else if (msg.type === "audio")    { msgType = "audio";    mediaId = msg.audio?.id }
  else if (msg.type === "video")    { msgType = "video";    mediaId = msg.video?.id }

  if (msgContent || mediaId) {
    await saveInboundMessage(vId, cId, phone, msgType, msgContent, mediaId)
  }

  // Auto-reply with vendor contact
  const vendorPhone = profile.whatsapp_number || ""
  const autoReply =
    msg.type === "audio"
      ? (vendorPhone
          ? `Voice messages are not supported right now.\n\nPlease call the vendor for quick help:\n*${vendorPhone}*`
          : `Voice messages are not supported right now.\n\nPlease call the vendor for quick help.`)
      : (vendorPhone
          ? `Thank you for your message.\n\nOur team has received it and will review it.\n\nFor immediate help, please call:\n*${vendorPhone}*`
          : `Thank you for your message.\n\nOur team will review it and get back to you if needed.`)
  await sendText(pid, phone, autoReply)

  // If customer has no address, always re-show registration — never show menu
  const fallbackAddr = await getAddress(cId, vId)
  if (!fallbackAddr) {
    const bizName = (profile?.business_name || "MilkRoute").trim()
    await sendText(pid, phone,
      `Welcome to *${bizName}*!\n\nTo start receiving daily deliveries, please complete your account setup by tapping the button below.`
    )
    const sent = await sendRegistrationFlow(pid, phone, vId, cId, bizName)
    await setState(phone, sent ? "awaiting_registration" : "menu", vId)
    return
  }

  const sub   = await getSubscription(cId, vId)
  const pause = await getActivePause(cId, vId)
  await setState(phone, "menu", vId)
  await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
}

module.exports = handleCustomerBot


