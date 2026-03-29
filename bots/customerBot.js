const axios = require("axios")
const pool = require("../db")
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

/* ─── MENU SENDERS ─────────────────────────────────────── */

async function sendMainMenu(pid, phone, sub, profile, pause = null) {
  const name = (profile?.business_name || "Milk Service").trim()
  let header, rows

  if (!sub) {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = [
      { id: "subscribe", title: "🥛 Subscribe Now", description: "Start daily milk delivery" }
    ]
  } else if (sub.status === "active" && pause) {
    const until = pause.pause_until
      ? `until *${displayDate(pause.pause_until)}*`
      : `— resumes when you're ready`
    header = `🥛 *${name}*\n\n⏸ Delivery paused ${until}`
    rows = [
      { id: "view",         title: "📋 My Subscription",  description: "View delivery details"            },
      { id: "resume_pause", title: "▶️ Resume Now",        description: "End pause & restart delivery"     },
      { id: "profile",      title: "📍 Update Address",    description: "Change delivery location"         },
      { id: "get_invoice",  title: "🧾 Get Bill",             description: "Receive your bill on WhatsApp"    }
    ]
  } else if (sub.status === "active") {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = [
      { id: "view",        title: "📋 My Subscription",  description: "View delivery details"       },
      { id: "change",      title: "✏️ Change Quantity",   description: "Update daily packets"        },
      { id: "profile",     title: "📍 Update Address",    description: "Change delivery location"    },
      { id: "pause",       title: "⏸ Pause Delivery",     description: "Skip delivery for some days" },
      { id: "get_invoice", title: "🧾 Get Bill",            description: "Receive your bill on WhatsApp"    }
    ]
  } else {
    header = `🥛 *${name}*\n\nHow can we help you today?`
    rows = [
      { id: "resume",      title: "▶️ Resume Delivery",   description: `Continue with ${sub.quantity} packet/day` },
      { id: "change",      title: "✏️ Change & Resume",   description: "Pick new quantity and restart"            },
      { id: "profile",     title: "📍 Update Address",    description: "Change delivery location"                 },
      { id: "get_invoice", title: "🧾 Get Invoice",        description: "Receive your invoice on WhatsApp"         }
    ]
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

async function confirmQty(pid, phone, cId, vId, qty, price, profile) {
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
  await sendMainMenu(pid, phone, s, profile, pause)
}

async function afterAddressComplete(pid, phone, cId, vId, profile, settings, afterAddr) {
  if (afterAddr) {
    const maxQty = settings.max_quantity_per_order || 5
    await sendQtyMenu(pid, phone, "sub", maxQty)
    await setState(phone, "sub_qty", vId)
  } else {
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause)
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

  let input = null
  if (msg.type === "text")        input = msg.text?.body?.trim()
  if (msg.type === "interactive") input = msg.interactive?.list_reply?.id
  if (!input) return

  const inputLower = input.toLowerCase()
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
      const welcome = sub?.status === "active"
        ? `👋 *Welcome back!*\n\nYour delivery: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}/day*\n📍 ${formatAddress(addr)}`
        : `👋 *Welcome to ${name}!*\n\nFresh milk delivered to your doorstep every day. 🥛`
      await sendText(pid, phone, welcome)
    }

    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause)
    return
  }

  /* ── Menu state ── */

  if (state.state === "menu") {
    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)

    // Subscribe (new or re-subscribe)
    if (input === "subscribe") {
      if (!isOrderWindowOpen(settings)) {
        const s = settings.order_accept_start || "N/A"
        const e = settings.order_accept_end   || "N/A"
        await sendText(pid, phone, `⏰ *Orders Closed*\n\nWe accept orders between *${s}* and *${e}*.\n\nPlease try again during order hours!`)
        return
      }
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
      if (!sub) { await sendMainMenu(pid, phone, sub, profile, pause); return }
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
      await sendMainMenu(pid, phone, sub, profile, pause)
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
      await sendList(pid, phone,
        "🧾 *Get Bill*\n\nSelect the period for your bill:",
        [
          { id: "inv_this_month", title: "This Month",   description: new Date().toLocaleString("en-IN", { month: "long", year: "numeric" }) },
          { id: "inv_last_month", title: "Last Month",   description: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" }) },
          { id: "inv_last_7",     title: "Last 7 Days",  description: "Past week's deliveries"  },
          { id: "inv_last_30",    title: "Last 30 Days", description: "Past month's deliveries" },
          { id: "menu",           title: "🏠 Main Menu",  description: ""                        },
        ],
        "Select"
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
      await sendMainMenu(pid, phone, s, profile, null)
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
      await sendMainMenu(pid, phone, s, profile, null)
      return
    }

    await sendMainMenu(pid, phone, sub, profile, pause)
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

    await confirmQty(pid, phone, cId, vId, qty, price, profile)
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

    await confirmQty(pid, phone, cId, vId, qty, price, profile)
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
      await sendMainMenu(pid, phone, s, profile, p)
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
      await sendMainMenu(pid, phone, s, profile, p)
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
      await afterAddressComplete(pid, phone, cId, vId, profile, settings, temp.after_addr)
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
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, t.after_addr)
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
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, state.temp_data?.after_addr)
    return
  }

  /* ── Invoice period selection ── */

  if (state.state === "invoice_period") {
    const periodMap = {
      inv_this_month: "this_month",
      inv_last_month: "last_month",
      inv_last_7:     "last_7",
      inv_last_30:    "last_30",
    }
    const period = periodMap[input]
    if (!period) {
      // Unknown input — go back to menu
      const sub   = await getSubscription(cId, vId)
      const pause = await getActivePause(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, sub, profile, pause)
      return
    }

    const range = getInvoiceDateRange(period)
    await sendText(pid, phone, `⏳ Generating your bill, please wait…`)

    try {
      const sent = await buildAndSendInvoice(pid, phone, cId, vId, range.from, range.to)
      if (!sent) {
        await sendText(pid, phone, `📭 No delivered orders found for this period.\n\nIf you think this is wrong, please contact your vendor.`)
      }
    } catch (err) {
      console.error("Invoice send error:", err.message)
      await sendText(pid, phone, `⚠️ Sorry, we couldn't generate your bill right now. Please try again later.`)
    }

    const sub   = await getSubscription(cId, vId)
    const pause = await getActivePause(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile, pause)
    return
  }

  /* ── Fallback ── */

  const sub   = await getSubscription(cId, vId)
  const pause = await getActivePause(cId, vId)
  await setState(phone, "menu", vId)
  await sendMainMenu(pid, phone, sub, profile, pause)
}

module.exports = handleCustomerBot
