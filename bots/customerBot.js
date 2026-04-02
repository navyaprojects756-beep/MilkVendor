const axios = require("axios")
const path  = require("path")
const fs    = require("fs")
const pool  = require("../db")
const { generateInvoicePDF } = require("../services/invoicePDF")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

/* ─── WHATSAPP API ─────────────────────────────────────── */

async function sendWhatsApp(pid, payload) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${pid}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    )
  } catch (err) {
    console.log("WhatsApp Error:", err.response?.data || err.message)
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

// ── Send the registration flow template to a new user ──
// Fill in FLOW_ID after publishing the flow in Meta
const REGISTRATION_FLOW_ID       = process.env.REGISTRATION_FLOW_ID || "YOUR_FLOW_ID"
const REGISTRATION_TEMPLATE_NAME = "customer_registration"

async function sendRegistrationFlow(pid, phone, vendorId) {
  await sendWhatsApp(pid, {
    messaging_product: "whatsapp",
    to:   phone,
    type: "template",
    template: {
      name:     REGISTRATION_TEMPLATE_NAME,
      language: { code: "en" },
      components: [
        {
          type: "button",
          sub_type: "flow",
          index: "0",
          parameters: [
            {
              type:       "action",
              action: {
                flow_token: String(vendorId),  // passed back to endpoint so we know which vendor's apartments to show
              }
            }
          ]
        }
      ]
    }
  })
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

/* ─── HELPERS ──────────────────────────────────────────── */

function nav(rows) {
  return [...rows, { id: "menu", title: "🏠 Main Menu" }]
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

function isOrderWindowOpen(settings) {
  if (!settings.order_window_enabled) return true
  const now = new Date()
  const day = now.getDay()
  const activeDays = (settings.active_days || [0, 1, 2, 3, 4, 5, 6]).map(Number)
  if (!activeDays.includes(day)) return false
  if (!settings.order_accept_start || !settings.order_accept_end) return true
  const toMins = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m }
  const nowMins = now.getHours() * 60 + now.getMinutes()
  return nowMins >= toMins(settings.order_accept_start) && nowMins <= toMins(settings.order_accept_end)
}

/* ─── DATE HELPERS ─────────────────────────────────────── */

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
  if (!val) return "—"
  // pg returns DATE columns as JS Date objects (midnight UTC); strings come as "YYYY-MM-DD"
  const iso = val instanceof Date ? val.toISOString() : String(val)
  const [yr, mo, dy] = iso.slice(0, 10).split("-").map(Number)
  return new Date(yr, mo - 1, dy).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}


/* ─── DB HELPERS ───────────────────────────────────────── */

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

async function saveSubscription(cId, vId, qty) {
  await pool.query(`
    INSERT INTO subscriptions(customer_id, vendor_id, quantity, status)
    VALUES($1, $2, $3, 'active')
    ON CONFLICT(customer_id, vendor_id)
    DO UPDATE SET quantity=$3, status='active'
  `, [cId, vId, qty])
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

/* ─── INVOICE HELPERS ──────────────────────────────────── */

function getInvoiceDateRange(period) {
  const now = new Date()
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
    const to    = new Date(); to.setDate(to.getDate() - 1)
    const from  = new Date(to); from.setDate(to.getDate() - 6)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  if (period === "last_30") {
    const to    = new Date(); to.setDate(to.getDate() - 1)
    const from  = new Date(to); from.setDate(to.getDate() - 29)
    return { from: dateToStr(from), to: dateToStr(to) }
  }
  return null
}

async function buildAndSendInvoice(pid, phone, cId, vId, from, to) {
  const [custR, ordersR, settingsR, profileR] = await Promise.all([
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
      `SELECT order_date, quantity, is_delivered FROM orders
       WHERE customer_id=$1 AND vendor_id=$2
         AND order_date>=$3 AND order_date<=$4
       ORDER BY order_date`,
      [cId, vId, from, to]
    ),
    pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vId]),
    pool.query("SELECT business_name, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id=$1", [vId]),
  ])

  const data = {
    customer:       custR.rows[0],
    orders:         ordersR.rows,
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
      caption: `🧾 Your milk bill (${displayDate(from)} – ${displayDate(to)})`
    }
  })

  return true
}

/* ─── PAUSE HELPERS ────────────────────────────────────── */

async function getActivePause(cId, vId) {
  const r = await pool.query(`
    SELECT * FROM subscription_pauses
    WHERE customer_id=$1 AND vendor_id=$2
      AND (pause_until IS NULL OR pause_until >= CURRENT_DATE)
    ORDER BY pause_from ASC LIMIT 1
  `, [cId, vId])
  return r.rows[0] || null
}

async function savePause(cId, vId, from, until) {
  await pool.query(
    "INSERT INTO subscription_pauses(customer_id, vendor_id, pause_from, pause_until) VALUES($1,$2,$3,$4)",
    [cId, vId, from, until]
  )
}

async function deletePause(pauseId) {
  await pool.query("DELETE FROM subscription_pauses WHERE pause_id=$1", [pauseId])
}

/* ─── PAYMENT HELPERS ──────────────────────────────────── */

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


/* ─── MENU SENDERS ─────────────────────────────────────── */

async function sendMainMenu(pid, phone, sub, profile, pause = null, withProducts = false) {
  const name = (profile?.business_name || "Milk Service").trim()
  let header, rows

  if (!sub) {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = withProducts
      ? [{ id: "manage_products", title: "📦 Browse Products", description: "Subscribe to our products" }]
      : [{ id: "subscribe", title: "🥛 Subscribe Now", description: "Start daily milk delivery" }]
  } else if (sub.status === "active" && pause) {
    const until = pause.pause_until
      ? `until *${displayDate(pause.pause_until)}*`
      : `— resumes when you're ready`
    header = `🥛 *${name}*\n\n⏸ Delivery paused ${until}`
    rows = [
      { id: "view",         title: "📋 My Subscription",  description: "View delivery details"         },
      { id: "resume_pause", title: "▶️ Resume Now",        description: "End pause & restart delivery"  },
      { id: "profile",      title: "📍 Update Address",    description: "Change delivery location"      },
      { id: "get_invoice",  title: "🧾 Get Bill",          description: "Download your bill"            },
    ]
    if (withProducts) {
      rows.splice(1, 0, { id: "manage_products", title: "📦 My Products",  description: "Manage daily subscriptions" })
    }
  } else if (sub.status === "active") {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = [
      { id: "view",        title: "📋 My Subscription",  description: "View delivery details"       },
      { id: "profile",     title: "📍 Update Address",    description: "Change delivery location"    },
      { id: "pause",       title: "⏸ Pause Delivery",     description: "Skip delivery for some days" },
      { id: "get_invoice", title: "🧾 Get Bill",          description: "Download your bill"          },
    ]
    if (withProducts) {
      rows.splice(1, 0, { id: "manage_products", title: "📦 My Products",  description: "Manage daily subscriptions" })
      rows.splice(2, 0, { id: "adhoc_order",     title: "🛒 Quick Order",  description: "Order extra items for tomorrow" })
    } else {
      rows.splice(1, 0, { id: "change", title: "✏️ Change Quantity", description: "Update daily packets" })
    }
  } else {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = [
      { id: "profile",     title: "📍 Update Address",    description: "Change delivery location" },
      { id: "get_invoice", title: "🧾 Get Bill",          description: "Download your bill"       },
    ]
    if (withProducts) {
      rows.unshift({ id: "manage_products", title: "📦 Restart Delivery", description: "Choose products and subscribe again" })
    } else {
      rows.unshift(
        { id: "resume",  title: "▶️ Resume Delivery",  description: `Continue with ${sub.quantity} packet/day` },
        { id: "change",  title: "✏️ Change & Resume",  description: "Pick new quantity and restart"            }
      )
    }
  }

  await sendList(pid, phone, header, rows, "View Options")
}

async function sendQtyMenu(pid, phone, prefix, maxQty = 5, price = 0) {
  const limit = Math.min(maxQty, 5)
  const rows = Array.from({ length: limit }, (_, i) => {
    const n = i + 1
    const priceStr = price > 0 ? ` · ₹${price * n}/day` : ""
    return {
      id: `${prefix}_${n}`,
      title: `${n} Packet${n > 1 ? "s" : ""} — 500ml each`,
      description: `${n} × 500ml${priceStr}`
    }
  })
  rows.push({ id: `${prefix}_custom`, title: "✏️ Custom Packets", description: "Enter any number of packets" })
  await sendList(pid, phone, "🥛 *Select Daily Quantity*\n\nHow many milk packets per day?", nav(rows), "Choose")
}

async function sendPauseMenu(pid, phone) {
  await sendList(pid, phone,
    "⏸ *Pause Delivery*\n\nHow long would you like to pause your delivery?",
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
      { id: "pause_now", title: "⏸ Until I Resume", description: "No end date — resume manually" }
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
    "🏢 *Select Your Apartment / Society*\n\nChoose from the list below:",
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
        ? `✅ In cart: ${inCart} × ₹${(p.price * inCart).toFixed(0)}`
        : `₹${p.price}${p.delivery_charge > 0 ? ` + ₹${p.delivery_charge} del` : ""}`
      ).slice(0, 72),
    }
  })

  const cartCount = cart.length
  const headerSuffix = cartCount > 0
    ? `\n\n🛒 *${cartCount} item${cartCount > 1 ? "s" : ""} in cart* — tap Place Order when ready`
    : `\n\nTap a product to add it to your order:`

  if (cartCount > 0) {
    rows.push({ id: "adhoc_place_order", title: "✅ Place Order" })
  }
  rows.push({ id: "menu", title: "🏠 Main Menu" })

  await sendList(pid, phone,
    `🛒 *Quick Order*${headerSuffix}`,
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
    "🏢 *Select Your Block / Tower*",
    nav(r.rows.map(x => ({ id: `block_${x.block_id}`, title: x.block_name }))),
    "Select"
  )
  return true
}

/* ─── ADDRESS FLOW ─────────────────────────────────────── */

async function startAddressFlow(pid, phone, vendor, settings, afterAddr = false) {
  const temp = { after_addr: afterAddr }
  const allowApt   = settings.allow_apartments !== false
  const allowHouse = settings.allow_houses !== false

  if (allowApt && allowHouse) {
    await sendList(pid, phone,
      "📍 *Where should we deliver?*\n\nSelect your address type:",
      nav([
        { id: "apt",   title: "🏢 Apartment / Society", description: "Flat in a gated community" },
        { id: "house", title: "🏠 Independent House",   description: "Individual house or villa"  }
      ]),
      "Select"
    )
    await setState(phone, "addr_type", vendor.vendor_id, temp)
  } else if (allowApt) {
    const ok = await sendApartmentMenu(pid, phone, vendor.vendor_id)
    if (ok) await setState(phone, "apt", vendor.vendor_id, temp)
    else {
      await sendText(pid, phone, "⚠️ No apartments are registered yet. Please contact support.")
      await setState(phone, "menu", vendor.vendor_id)
    }
  } else if (allowHouse) {
    await sendText(pid, phone, "🏠 *Enter Your Delivery Address*\n\nPlease type your full house address:")
    await setState(phone, "manual", vendor.vendor_id, temp)
  } else {
    await sendText(pid, phone, "⚠️ Address registration is currently unavailable. Please contact support.")
  }
}

async function confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts = false) {
  await saveSubscription(cId, vId, qty)
  const addr  = await getAddress(cId, vId)
  const pause = await getActivePause(cId, vId)

  let confirm = `✅ *Subscription Confirmed!*\n\n`
  confirm += `🥛 *${qty} packet${qty > 1 ? "s" : ""}* × 500ml delivered every day\n`
  if (price > 0) confirm += `💰 ₹${price * qty}/day\n`
  confirm += `📍 ${formatAddress(addr)}\n\nDelivery starts tomorrow! 🎉`

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

/* ─── MAIN HANDLER ─────────────────────────────────────── */

async function handleCustomerBot(msg, pid) {
  const phone = msg.from

  console.log("🤖 CustomerBot | phone:", phone, "| pid:", pid)

  const vendor = await getVendor(pid)
  if (!vendor) {
    console.log("❌ No vendor found for phone_number_id:", pid)
    return
  }
  if (!vendor.is_active) {
    console.log("❌ Vendor is inactive:", vendor.vendor_id)
    return
  }

  console.log("✅ Vendor:", vendor.vendor_id, vendor.vendor_name || "")

  const customer = await getCustomer(phone)
  const state    = await getState(phone)
  const settings = await getSettings(vendor.vendor_id)
  const profile  = await getProfile(vendor.vendor_id)

  console.log("👤 Customer:", customer.customer_id, "| State:", state?.state || "none")

  const withProducts = await hasVendorProducts(vendor.vendor_id)

  let input = null
  if (msg.type === "text")        input = msg.text?.body?.trim()
  if (msg.type === "interactive") input = msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id

  // ── Handle flow form submission ──
  const isFlowReply = msg.type === "interactive" && msg.interactive?.type === "nfm_reply"
  if (isFlowReply) {
    const formData = JSON.parse(msg.interactive.nfm_reply.response_json || "{}")
    const name     = formData.customer_name || ""

    // Save name to customers table
    if (name) {
      await pool.query("UPDATE customers SET name=$1 WHERE customer_id=$2", [name, cId])
    }

    if (formData.address_type === "apartment") {
      await saveApartment(cId, vId, formData.apartment_id, formData.block_id, formData.flat_number)
    } else if (formData.address_type === "house") {
      await saveManual(cId, vId, formData.manual_address)
    }

    await sendText(pid, phone, `✅ *Registration complete!*\n\nWelcome${name ? `, ${name}` : ""}! 🎉\n\nYour address has been saved. You can now subscribe to daily deliveries.`)
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
  const vId = vendor.vendor_id
  const cId = customer.customer_id

  /* ── Global: greetings and menu reset ── */

  const isReset   = ["hi", "hello", "start"].includes(inputLower)
  const isMenuNav = inputLower === "menu"

  if (!state || isReset || isMenuNav) {
    const sub   = await getSubscription(cId, vId)
    const addr  = await getAddress(cId, vId)
    const pause = await getActivePause(cId, vId)
    const name  = (profile?.business_name || "Milk Service").trim()

    if (!state || isReset) {
      // ── New user with no address → send registration flow ──
      if (!addr && !sub) {
        await sendRegistrationFlow(pid, phone, vId)
        await setState(phone, "awaiting_registration", vId)
        return
      }

      let welcome
      if (withProducts && sub?.status === "active") {
        const subs = await getCustomerProductSubs(cId, vId)
        const activeProducts = subs.filter(s => s.is_active)
        if (activeProducts.length > 0) {
          const lines = activeProducts.map(s => `• ${s.name}${s.unit ? ` (${s.unit})` : ""} × ${s.quantity}`).join("\n")
          welcome = `👋 *Welcome back!*\n\n📦 Your daily order:\n${lines}\n📍 ${formatAddress(addr)}`
        } else {
          welcome = `👋 *Welcome to ${name}!*\n\nBrowse our products and subscribe to daily delivery. 🥛`
        }
      } else if (sub?.status === "active") {
        welcome = `👋 *Welcome back!*\n\nYour delivery: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}/day*\n📍 ${formatAddress(addr)}`
      } else {
        welcome = `👋 *Welcome to ${name}!*\n\nFresh milk & dairy products delivered to your doorstep. 🥛`
      }
      await sendText(pid, phone, welcome)

      if (!isOrderWindowOpen(settings)) {
        const s = settings.order_accept_start || "—"
        const e = settings.order_accept_end   || "—"
        await sendText(pid, phone,
          `⏰ *Order window is currently closed.*\n\nWe accept messages from *${s}* to *${e}*.\n\nChanges can only be made during order hours.`
        )
      }
    }

    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
    return
  }

  /* ── Block all actions outside order window ── */

  if (!isOrderWindowOpen(settings)) {
    const s = settings.order_accept_start || "—"
    const e = settings.order_accept_end   || "—"
    await sendText(pid, phone,
      `⏰ *Sorry, we are not accepting messages right now.*\n\nOur order window is open from *${s}* to *${e}*.\n\nPlease message us during those hours and we'll be happy to help! 🙏`
    )
    return
  }

  /* ── Menu state ── */

  if (state.state === "menu") {
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)

    // ── Manage per-product subscriptions ──
    if (input === "manage_products") {
      const products = await getVendorProducts(vId, "subscription")
      if (products.length === 0) {
        await sendText(pid, phone, "⚠️ No subscription products available right now. Please check back later.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const customerSubs = await getCustomerProductSubs(cId, vId)
      const subMap = {}
      customerSubs.forEach(s => { subMap[s.product_id] = s })

      const rows = products.map(p => {
        const cs = subMap[p.product_id]
        const status = (cs && cs.is_active)
          ? `✅ ${cs.quantity}/day — ₹${(p.price * cs.quantity).toFixed(0)}`
          : `○ Not subscribed`
        return {
          id:          `prd_${p.product_id}`,
          title:       `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24),
          description: `${status} · ₹${p.price}${p.delivery_charge > 0 ? ` +₹${p.delivery_charge} del` : ""}`.slice(0, 72),
        }
      })
      rows.push({ id: "menu", title: "🏠 Main Menu" })

      await sendList(pid, phone,
        `📦 *Your Daily Products*\n\nTap a product to subscribe or update quantity.\n✅ = currently subscribed`,
        rows, "Manage"
      )
      await setState(phone, "manage_products", vId)
      return
    }

    // ── Adhoc / Quick Order ──
    if (input === "adhoc_order") {
      const products = await getVendorProducts(vId, "adhoc")
      if (products.length === 0) {
        await sendText(pid, phone, "⚠️ No quick-order products available right now.")
        await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
        return
      }
      const rows = products.map(p => ({
        id:          `adhoc_${p.product_id}`,
        title:       `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24),
        description: `₹${p.price}${p.delivery_charge > 0 ? ` + ₹${p.delivery_charge} del` : ""}`.slice(0, 72),
      }))
      rows.push({ id: "menu", title: "🏠 Main Menu" })

      await sendList(pid, phone,
        `🛒 *Quick Order*\n\nSelect products for tomorrow. You can add multiple items.\n\n_(Tap a product to add to your order)_`,
        rows, "Select"
      )
      // cart = [] initially
      await setState(phone, "adhoc_product", vId, { cart: [] })
      return
    }

    // Subscribe (new or re-subscribe)
    if (input === "subscribe") {
      const addr = await getAddress(cId, vId)
      if (!addr) {
        await sendText(pid, phone, "📍 *First, let's save your delivery address.*\n\nThis only takes a moment!")
        await startAddressFlow(pid, phone, vendor, settings, true)
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
      if (!sub) { await sendMainMenu(pid, phone, sub, profile, pause, withProducts); return }
      const addr  = await getAddress(cId, vId)
      const price = settings.price_per_unit || 0
      let text = `📋 *Your Subscription*\n\n`
      text += `🥛 Quantity: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}* per day\n`
      if (price > 0) {
        text += `💰 Rate: ₹${price} per packet\n`
        text += `🗒 Monthly estimate: ₹${sub.quantity * price * 30}\n`
      }
      text += `📍 Address: ${formatAddress(addr)}\n`
      if (pause) {
        text += pause.pause_until
          ? `\n⏸ *Paused from ${displayDate(pause.pause_from)} to ${displayDate(pause.pause_until)}*`
          : `\n⏸ *Paused (manual resume)*`
      } else {
        text += `\n✅ Status: Active`
      }
      await sendText(pid, phone, text)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Change quantity
    if (input === "change") {
      const maxQty = settings.max_quantity_per_order || 5
      const price  = settings.price_per_unit || 0
      await sendQtyMenu(pid, phone, "chg", maxQty, price)
      await setState(phone, "chg_qty", vId)
      return
    }

    // Update address
    if (input === "profile") {
      const addr = await getAddress(cId, vId)
      if (addr) await sendText(pid, phone, `📍 *Current Address:* ${formatAddress(addr)}\n\nSelect a new address below:`)
      await startAddressFlow(pid, phone, vendor, settings, false)
      return
    }

    // Get invoice
    if (input === "get_invoice") {
      const now       = new Date()
      const thisMonth = now.toLocaleString("en-IN", { month: "long", year: "numeric" })
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
                          .toLocaleString("en-IN", { month: "long", year: "numeric" })
      await sendButtons(pid, phone,
        `🧾 *Get Bill*\n\nWhich month's bill do you need?\n\n📅 This Month: ${thisMonth}\n📅 Last Month: ${lastMonth}`,
        [
          { id: "inv_this_month", title: "This Month" },
          { id: "inv_last_month", title: "Last Month"  },
        ]
      )
      await setState(phone, "invoice_period", vId)
      return
    }

    // Pause delivery — opens pause submenu
    if (input === "pause") {
      await sendPauseMenu(pid, phone)
      await setState(phone, "pause_select", vId)
      return
    }

    // Resume from pause (customer has active pause)
    if (input === "resume_pause") {
      if (pause) await deletePause(pause.pause_id)
      const addr = await getAddress(cId, vId)
      const qty  = sub?.quantity || 1
      await sendText(pid, phone, `▶️ *Delivery Resumed!*\n\n🥛 *${qty} packet${qty > 1 ? "s" : ""}*/day starting tomorrow\n📍 ${formatAddress(addr)}\n\nSee you tomorrow! 🎉`)
      const s = await getSubscription(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, null, withProducts)
      return
    }

    // Resume inactive subscription
    if (input === "resume") {
      await pool.query(
        "UPDATE subscriptions SET status='active' WHERE customer_id=$1 AND vendor_id=$2",
        [cId, vId]
      )
      const addr = await getAddress(cId, vId)
      const qty  = sub?.quantity || 1
      await sendText(pid, phone, `▶️ *Delivery Resumed!*\n\n🥛 ${qty} packet${qty > 1 ? "s" : ""}/day will be delivered to:\n📍 ${formatAddress(addr)}\n\nSee you tomorrow! 🎉`)
      const s = await getSubscription(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, null, withProducts)
      return
    }

    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
    return
  }

  /* ── Quantity selection ── */

  if (state.state === "sub_qty" || state.state === "chg_qty") {
    const prefix = state.state === "sub_qty" ? "sub" : "chg"
    const maxQty = settings.max_quantity_per_order || 5
    const price  = settings.price_per_unit || 0

    // Custom option selected — ask user to type a number
    if (input === `${prefix}_custom`) {
      await sendText(pid, phone, `✏️ *Enter Number of Packets*\n\nType how many packets you want per day:\n(e.g. *6*, *8*, *10*)`)
      await setState(phone, "custom_qty", vId, { prefix })
      return
    }

    const parts = input.split("_")
    const qty   = parseInt(parts[parts.length - 1])

    if (isNaN(qty) || qty < 1) {
      await sendText(pid, phone, "⚠️ Please choose a quantity from the list.")
      await sendQtyMenu(pid, phone, prefix, maxQty, price)
      return
    }

    await confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts)
    return
  }

  /* ── Custom quantity text input ── */

  if (state.state === "custom_qty") {
    const qty    = parseInt(input.trim())
    const price  = settings.price_per_unit || 0
    const maxQty = settings.max_quantity_per_order || 0

    if (isNaN(qty) || !/^\d+$/.test(input.trim())) {
      await sendText(pid, phone, "⚠️ Please enter a valid number (e.g. *6*, *8*, *10*).")
      return
    }
    if (qty < 1) {
      await sendText(pid, phone, "⚠️ Minimum is 1 packet. Please enter a valid number:")
      return
    }
    if (maxQty > 0 && qty > maxQty) {
      await sendText(pid, phone, `⚠️ Maximum allowed is *${maxQty} packets* per day. Please enter a smaller number:`)
      return
    }

    await confirmQty(pid, phone, cId, vId, qty, price, profile, withProducts)
    return
  }

  /* ── Pause selection ── */

  if (state.state === "pause_select") {
    const today    = new Date(); today.setHours(0, 0, 0, 0)
    const tomorrow = addDays(today, 1)

    const dayMatch = input.match(/^pause_(\d+)$/)
    if (dayMatch) {
      const days      = parseInt(dayMatch[1])
      const from      = dateToStr(tomorrow)
      const until     = dateToStr(addDays(tomorrow, days - 1))
      const resumeDay = displayDate(dateToStr(addDays(tomorrow, days)))
      const label     = days === 7 ? "1 Week" : days === 14 ? "2 Weeks" : days === 30 ? "1 Month" : `${days} Day${days > 1 ? "s" : ""}`
      await savePause(cId, vId, from, until)
      await sendText(pid, phone,
        `⏸ *Delivery Paused for ${label}!*\n\n` +
        `🗒 From: ${displayDate(from)}\n` +
        `🗒 To: ${displayDate(until)}\n\n` +
        `Delivery will resume automatically on *${resumeDay}*. 🥛`
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
      await sendText(pid, phone,
        `⏸ *Delivery Paused!*\n\n🗒 Starting: ${displayDate(from)}\n\nWe'll wait for you. 🥛`
      )
      const s = await getSubscription(cId, vId)
      const p = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile, p, withProducts)
      return
    }

    // Invalid tap — redisplay
    await sendPauseMenu(pid, phone)
    return
  }

  /* ── Address type selection ── */

  if (state.state === "addr_type") {
    const afterAddr = state.temp_data?.after_addr || false
    const temp = { after_addr: afterAddr }

    if (input === "apt") {
      const ok = await sendApartmentMenu(pid, phone, vId)
      if (ok) await setState(phone, "apt", vId, temp)
      else {
        await sendText(pid, phone, "⚠️ No apartments available right now. Please try house address or contact support.")
        await setState(phone, "menu", vId)
      }
    } else if (input === "house") {
      await sendText(pid, phone, "🏠 *Enter Your Delivery Address*\n\nType your full house address\n(e.g. 12, Rose Street, Sector 5):")
      await setState(phone, "manual", vId, temp)
    } else {
      await sendText(pid, phone, "⚠️ Please select from the options provided.")
    }
    return
  }

  /* ── Apartment selection ── */

  if (state.state === "apt") {
    if (!input.startsWith("apt_")) {
      await sendApartmentMenu(pid, phone, vId)
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
        await sendText(pid, phone, "🏠 *Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
        await setState(phone, "flat", vId, { ...temp, blockId: null })
      }
    } else {
      await sendText(pid, phone, "🏠 *Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
      await setState(phone, "flat", vId, { ...temp, blockId: null })
    }
    return
  }

  /* ── Block selection ── */

  if (state.state === "block") {
    if (!input.startsWith("block_")) {
      const aptId = state.temp_data?.aptId
      if (aptId) await sendBlockMenu(pid, phone, aptId)
      return
    }
    const blockId     = input.split("_")[1]
    const temp        = { ...state.temp_data, blockId }
    const requireFlat = settings.require_flat_number !== false

    if (requireFlat) {
      await sendText(pid, phone, "🏠 *Enter Your Flat Number*\n\n(e.g. A-101, 304, Ground Floor)")
      await setState(phone, "flat", vId, temp)
    } else {
      await saveApartment(cId, vId, temp.aptId, blockId, null)
      await sendText(pid, phone, "✅ *Address Saved!*\n\nYour delivery address has been updated.")
      await afterAddressComplete(pid, phone, cId, vId, profile, settings, temp.after_addr, withProducts)
    }
    return
  }

  /* ── Flat number entry ── */

  if (state.state === "flat") {
    const flat = input.trim()
    if (!flat || flat.length > 20) {
      await sendText(pid, phone, "⚠️ Please enter a valid flat number (e.g. A-101, 304, Ground Floor)")
      return
    }
    const t = state.temp_data || {}
    await saveApartment(cId, vId, t.aptId, t.blockId, flat)
    await sendText(pid, phone, "✅ *Address Saved!*\n\nYour delivery address has been updated.")
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, t.after_addr, withProducts)
    return
  }

  /* ── Manual house address ── */

  if (state.state === "manual") {
    const address = input.trim()
    if (address.length < 5) {
      await sendText(pid, phone, "⚠️ Please enter a complete address (at least 5 characters).")
      return
    }
    if (address.length > 200) {
      await sendText(pid, phone, "⚠️ Address too long. Please keep it under 200 characters.")
      return
    }
    await saveManual(cId, vId, address)
    await sendText(pid, phone, "✅ *Address Saved!*\n\nYour delivery address has been updated.")
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, state.temp_data?.after_addr, withProducts)
    return
  }

  /* ── Bill period selection → send PDF + summary + Mark as Paid option ── */

  if (state.state === "invoice_period") {
    const periodMap = {
      inv_this_month: { key: "this_month", label: "This Month" },
      inv_last_month: { key: "last_month", label: "Last Month" },
    }
    const entry = periodMap[input]
    if (!entry) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    const range = getInvoiceDateRange(entry.key)
    await sendText(pid, phone, `⏳ Generating your bill, please wait…`)

    // Get delivered (all) and unpaid separately
    const [allR, unpaidR, settingsR] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(quantity),0) AS qty FROM orders
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4 AND is_delivered=true`,
        [cId, vId, range.from, range.to]
      ),
      pool.query(
        `SELECT COALESCE(SUM(quantity),0) AS qty FROM orders
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4
           AND is_delivered=true AND COALESCE(payment_status,'unpaid')='unpaid'`,
        [cId, vId, range.from, range.to]
      ),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vId]),
    ])

    const totalDelivered = parseInt(allR.rows[0].qty)
    const unpaidQty      = parseInt(unpaidR.rows[0].qty)
    const pricePerUnit   = parseFloat(settingsR.rows[0]?.price_per_unit || 0)
    const unpaidAmount   = unpaidQty * pricePerUnit
    const paidQty        = totalDelivered - unpaidQty

    if (totalDelivered === 0) {
      await sendText(pid, phone, `📭 No delivered orders found for this period.\n\nIf you think this is wrong, please contact your vendor.`)
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Send PDF (shows all delivered)
    try {
      await buildAndSendInvoice(pid, phone, cId, vId, range.from, range.to)
    } catch (err) {
      console.error("Invoice send error:", err.message)
      await sendText(pid, phone, `⚠️ Sorry, we couldn't generate your bill right now. Please try again later.`)
      await setState(phone, "menu", vId)
      return
    }

    // All already paid
    if (unpaidQty === 0) {
      await sendText(pid, phone,
        `✅ *Bill — ${entry.label}*\n\n` +
        `📅 ${displayDate(range.from)} → ${displayDate(range.to)}\n` +
        `📦 Delivered: ${totalDelivered} packet${totalDelivered > 1 ? "s" : ""}\n` +
        `${pricePerUnit > 0 ? `🧾 Total: ₹${(totalDelivered * pricePerUnit).toFixed(2)}\n` : ""}` +
        `\n🎉 *This bill is fully paid!* Thank you.`
      )
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    // Some or all unpaid — show split summary
    const paidLine   = paidQty > 0 ? `✅ Paid: ${paidQty} packet${paidQty > 1 ? "s" : ""}\n` : ""
    const amtLine    = pricePerUnit > 0
      ? `💰 Rate: ₹${pricePerUnit}/packet\n🧾 *Amount Due: ₹${unpaidAmount.toFixed(2)}*`
      : `📦 Unpaid packets: ${unpaidQty}`

    await sendButtons(pid, phone,
      `📊 *Bill — ${entry.label}*\n\n` +
      `📅 ${displayDate(range.from)} → ${displayDate(range.to)}\n` +
      `📦 Total delivered: ${totalDelivered} packets\n` +
      `${paidLine}` +
      `⏳ Pending: ${unpaidQty} packet${unpaidQty > 1 ? "s" : ""}\n` +
      `${amtLine}\n\n` +
      `Already paid? Tap *Mark as Paid* and we'll record it.`,
      [
        { id: "confirm_pay", title: "✅ Mark as Paid" },
        { id: "menu",        title: "🏠 Main Menu"   },
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

  /* ── Mark as Paid confirmed → ask screenshot only ── */

  if (state.state === "pay_confirm") {
    if (input !== "confirm_pay") {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    await setState(phone, "payment_screenshot", vId, state.temp_data)
    await sendButtons(pid, phone,
      `📸 *Payment Screenshot*\n\nSend a screenshot of your payment for our records, or tap Skip.`,
      [{ id: "skip_screenshot", title: "⏭ Skip" }]
    )
    return
  }

  /* ── Payment screenshot (image or "skip") ── */

  if (state.state === "payment_screenshot") {
    const { totalAmount, periodLabel, periodFrom, periodTo } = state.temp_data || {}
    let screenshotUrl = null

    const isSkip = input === "skip_screenshot" || inputLower === "skip"

    if (msg.type === "image" && msg.image?.id) {
      screenshotUrl = await downloadWhatsAppMedia(msg.image.id)
    } else if (!isSkip) {
      await sendButtons(pid, phone,
        "📎 Please send a screenshot image, or tap Skip to continue without one.",
        [{ id: "skip_screenshot", title: "⏭ Skip" }]
      )
      return
    }

    // Record payment with period
    await pool.query(`
      INSERT INTO payments
        (customer_id, vendor_id, amount, payment_method, screenshot_url,
         recorded_by, payment_date, period_from, period_to)
      VALUES ($1,$2,$3,'other',$4,'customer',CURRENT_DATE,$5,$6)
    `, [cId, vId, totalAmount || 0, screenshotUrl, periodFrom || null, periodTo || null])

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
      `✅ *Payment Recorded!*\n\n` +
      `${periodLabel ? `📅 Period: ${periodLabel}\n` : ""}` +
      `💰 Amount: ₹${Number(totalAmount || 0).toFixed(2)}\n\n` +
      `Thank you! Your vendor has been notified. 🙏`
    )
    await setState(phone, "menu", vId)
    return
  }

  /* ── Manage per-product subscriptions: product selected ── */

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
        await sendText(pid, phone, "⚠️ Product not found. Please try again.")
        return
      }
      const customerSubs = await getCustomerProductSubs(cId, vId)
      const current = customerSubs.find(s => s.product_id === productId)
      const currentQty = (current && current.is_active) ? current.quantity : 0

      const priceInfo = `₹${product.price}${product.delivery_charge > 0 ? ` + ₹${product.delivery_charge} delivery` : ""}`
      const currentInfo = currentQty > 0
        ? `Currently: *${currentQty}/day* (₹${(product.price * currentQty).toFixed(0)}/day)`
        : `Currently: *not subscribed*`

      await sendText(pid, phone,
        `📦 *${product.name}${product.unit ? ` (${product.unit})` : ""}*\n\n` +
        `${currentInfo}\n💰 Price: ${priceInfo}\n\n` +
        `How many do you want per day?\nEnter *0* to unsubscribe.\n(e.g. 1, 2, 3…)`
      )
      await setState(phone, "product_qty", vId, {
        product_id:      productId,
        product_name:    product.name,
        product_unit:    product.unit,
        price:           product.price,
        delivery_charge: product.delivery_charge,
      })
      return
    }

    // Re-show the product list on any other input
    const products = await getVendorProducts(vId, "subscription")
    const customerSubs = await getCustomerProductSubs(cId, vId)
    const subMap = {}
    customerSubs.forEach(s => { subMap[s.product_id] = s })
    const rows = products.map(p => {
      const cs = subMap[p.product_id]
      const status = (cs && cs.is_active) ? `✅ ${cs.quantity}/day` : `○ Not subscribed`
      return { id: `prd_${p.product_id}`, title: `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24), description: status }
    })
    rows.push({ id: "menu", title: "🏠 Main Menu" })
    await sendList(pid, phone, `📦 *Your Daily Products*\n\nTap a product to update:`, rows, "Manage")
    return
  }

  /* ── Product quantity entry (subscription management) ── */

  if (state.state === "product_qty") {
    const qty = parseInt((input || "").trim())
    if (isNaN(qty) || qty < 0) {
      await sendText(pid, phone, "⚠️ Please enter a valid number (0 to unsubscribe, 1 or more to subscribe).")
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
        `✅ *${product_name}${product_unit ? ` (${product_unit})` : ""}* removed from your daily order.`
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
        `✅ *${product_name}${product_unit ? ` (${product_unit})` : ""}* — *${qty}/day*\n` +
        `💰 ₹${dailyCost}/day\n\nDelivery starts tomorrow! 🎉`
      )
    }

    // Go back to manage products view
    const products = await getVendorProducts(vId, "subscription")
    const customerSubs = await getCustomerProductSubs(cId, vId)
    const subMap = {}
    customerSubs.forEach(s => { subMap[s.product_id] = s })
    const rows = products.map(p => {
      const cs = subMap[p.product_id]
      const status = (cs && cs.is_active) ? `✅ ${cs.quantity}/day` : `○ Not subscribed`
      return { id: `prd_${p.product_id}`, title: `${p.name}${p.unit ? ` ${p.unit}` : ""}`.slice(0, 24), description: status }
    })
    rows.push({ id: "menu", title: "🏠 Main Menu" })
    await sendList(pid, phone, `📦 *Your Products Updated!*\n\nTap another product to manage it:`, rows, "Manage")
    await setState(phone, "manage_products", vId)
    return
  }

  /* ── Adhoc: product list (cart-based multi-select) ── */

  if (state.state === "adhoc_product") {
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
      if (cart.length === 0) {
        await sendText(pid, phone, "⚠️ Your cart is empty. Please select a product first.")
        return
      }
      // Build summary and go to confirm state
      const lines = cart.map(item =>
        `• ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} × ${item.qty} — ₹${(item.price * item.qty + (item.delivery_charge || 0)).toFixed(2)}`
      ).join("\n")
      const grandTotal = cart.reduce((s, item) => s + item.price * item.qty + (item.delivery_charge || 0), 0).toFixed(2)

      await sendButtons(pid, phone,
        `🛒 *Order Summary*\n\n${lines}\n\n🧾 *Total: ₹${grandTotal}*\n📅 Delivery: tomorrow\n\nConfirm your order?`,
        [
          { id: "adhoc_confirm", title: "✅ Confirm Order" },
          { id: "adhoc_more",    title: "➕ Add More"      },
        ]
      )
      await setState(phone, "adhoc_confirm", vId, { cart })
      return
    }

    if (input?.startsWith("adhoc_")) {
      const productId = parseInt(input.split("_")[1])
      const prods = await getVendorProducts(vId, "adhoc")
      const product = prods.find(p => p.product_id === productId)
      if (!product) { await sendText(pid, phone, "⚠️ Product not found."); return }

      await sendText(pid, phone,
        `🛒 *${product.name}${product.unit ? ` (${product.unit})` : ""}*\n` +
        `💰 ₹${product.price}${product.delivery_charge > 0 ? ` + ₹${product.delivery_charge} delivery` : ""}\n\n` +
        `How many? (enter a number, e.g. 1, 2, 3)`
      )
      await setState(phone, "adhoc_qty", vId, {
        cart,
        product_id:      productId,
        product_name:    product.name,
        product_unit:    product.unit || "",
        price:           parseFloat(product.price),
        delivery_charge: parseFloat(product.delivery_charge || 0),
      })
      return
    }

    // Re-show product list
    await sendAdhocProductList(pid, phone, vId, cart)
    return
  }

  /* ── Adhoc: quantity entry ── */

  if (state.state === "adhoc_qty") {
    const qty = parseInt((input || "").trim())
    if (isNaN(qty) || qty < 1) {
      await sendText(pid, phone, "⚠️ Please enter a number of 1 or more (e.g. 1, 2, 3).")
      return
    }
    if (qty > 50) {
      await sendText(pid, phone, "⚠️ Maximum 50 per item. Please enter a smaller number.")
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
      `✅ ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} × ${item.qty}`
    ).join("\n")

    await sendButtons(pid, phone,
      `🛒 *Cart Updated!*\n\n${cartLines}\n\nDo you want to add more items or place the order?`,
      [
        { id: "adhoc_place_order", title: "✅ Place Order" },
        { id: "adhoc_add_more",    title: "➕ Add More"    },
      ]
    )
    await setState(phone, "adhoc_cart", vId, { cart })
    return
  }

  /* ── Adhoc: cart view (after adding item) ── */

  if (state.state === "adhoc_cart") {
    const cart = state.temp_data?.cart || []

    if (input === "adhoc_add_more" || input === "adhoc_more") {
      await sendAdhocProductList(pid, phone, vId, cart)
      await setState(phone, "adhoc_product", vId, { cart })
      return
    }

    if (input === "adhoc_place_order") {
      const lines = cart.map(item =>
        `• ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} × ${item.qty} — ₹${(item.price * item.qty + (item.delivery_charge || 0)).toFixed(2)}`
      ).join("\n")
      const grandTotal = cart.reduce((s, item) => s + item.price * item.qty + (item.delivery_charge || 0), 0).toFixed(2)

      await sendButtons(pid, phone,
        `🛒 *Order Summary*\n\n${lines}\n\n🧾 *Total: ₹${grandTotal}*\n📅 Delivery: tomorrow\n\nConfirm your order?`,
        [
          { id: "adhoc_confirm", title: "✅ Confirm Order" },
          { id: "adhoc_more",    title: "➕ Add More"      },
        ]
      )
      await setState(phone, "adhoc_confirm", vId, { cart })
      return
    }

    // Any other input — re-show cart
    const cartLines = cart.map(item => `✅ ${item.product_name} × ${item.qty}`).join("\n")
    await sendButtons(pid, phone,
      `🛒 *Your Cart:*\n\n${cartLines}\n\nWhat would you like to do?`,
      [
        { id: "adhoc_place_order", title: "✅ Place Order" },
        { id: "adhoc_add_more",    title: "➕ Add More"    },
      ]
    )
    return
  }

  /* ── Adhoc: order confirmation ── */

  if (state.state === "adhoc_confirm") {
    const cart = state.temp_data?.cart || []

    if (input === "adhoc_more" || input === "adhoc_add_more") {
      await sendAdhocProductList(pid, phone, vId, cart)
      await setState(phone, "adhoc_product", vId, { cart })
      return
    }

    if (input !== "adhoc_confirm") {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    if (cart.length === 0) {
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
      return
    }

    const tomorrow = dateToStr(addDays(new Date(), 1))

    // Find or create order for tomorrow
    const { rows: orderRows } = await pool.query(`
      INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
      VALUES ($1,$2,$3,0)
      ON CONFLICT (customer_id, vendor_id, order_date)
      DO UPDATE SET quantity = orders.quantity
      RETURNING order_id
    `, [cId, vId, tomorrow])
    const orderId = orderRows[0].order_id

    // Insert all cart items
    for (const item of cart) {
      await pool.query(`
        INSERT INTO order_items (order_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
        VALUES ($1,$2,$3,$4,$5,'adhoc')
        ON CONFLICT (order_id, product_id)
        DO UPDATE SET quantity = order_items.quantity + EXCLUDED.quantity
      `, [orderId, item.product_id, item.qty, item.price, item.delivery_charge || 0])
    }

    // Update order total quantity
    await pool.query(`
      UPDATE orders SET quantity = (
        SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = $1
      ) WHERE order_id = $1
    `, [orderId])

    const addr      = await getAddress(cId, vId)
    const grandTotal = cart.reduce((s, item) => s + item.price * item.qty + (item.delivery_charge || 0), 0).toFixed(2)
    const itemLines  = cart.map(item =>
      `📦 ${item.product_name}${item.product_unit ? ` (${item.product_unit})` : ""} × ${item.qty}`
    ).join("\n")

    await sendText(pid, phone,
      `✅ *Order Placed!*\n\n${itemLines}\n\n` +
      `🧾 Total: ₹${grandTotal}\n` +
      `📍 ${formatAddress(addr)}\n` +
      `📅 Delivery: tomorrow\n\nThank you! 🙏`
    )

    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
    return
  }

  /* ── Fallback: capture unhandled message → auto-reply ── */

  // Save inbound message to inbox
  let msgContent = null, msgType = "text", mediaId = null
  if (msg.type === "text")     { msgContent = msg.text?.body }
  else if (msg.type === "image")    { msgType = "image";    mediaId = msg.image?.id;    msgContent = msg.image?.caption }
  else if (msg.type === "document") { msgType = "document"; mediaId = msg.document?.id; msgContent = msg.document?.caption }
  else if (msg.type === "audio")    { msgType = "audio";    mediaId = msg.audio?.id }
  else if (msg.type === "video")    { msgType = "video";    mediaId = msg.video?.id }

  if (msgContent || mediaId) {
    await saveInboundMessage(vId, cId, phone, msgType, msgContent, mediaId)
  }

  // Auto-reply with vendor contact
  const vendorPhone = settings.vendor_phone || profile.whatsapp_number || ""
  const autoReply = vendorPhone
    ? `👋 Thank you for your message!\n\nOur team has received it and will review it.\n\nFor immediate help, please call:\n📞 *${vendorPhone}*`
    : `👋 Thank you for your message!\n\nOur team will review it and get back to you if needed.`
  await sendText(pid, phone, autoReply)

  const sub   = await getSubscription(cId, vId)
  const pause = await getActivePause(cId, vId)
  await setState(phone, "menu", vId)
  await sendMainMenu(pid, phone, sub, profile, pause, withProducts)
}

module.exports = handleCustomerBot
