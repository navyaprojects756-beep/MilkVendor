const axios = require("axios")
const pool = require("../db")

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
    if (addr.flat_number) parts.push(`Flat ${addr.flat_number}`)
    if (addr.block_name) parts.push(`Block ${addr.block_name}`)
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
  const r = await pool.query(
    "SELECT * FROM subscriptions WHERE customer_id=$1 AND vendor_id=$2",
    [cId, vId]
  )
  return r.rows[0] || null
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

/* ─── MENU SENDERS ─────────────────────────────────────── */

async function sendMainMenu(pid, phone, sub, profile) {
  const name = profile?.business_name || "Milk Service"
  let rows

  if (!sub) {
    rows = [
      { id: "subscribe", title: "🥛 Subscribe Now", description: "Start daily milk delivery" }
    ]
  } else if (sub.status === "active") {
    rows = [
      { id: "view",    title: "📋 My Subscription",  description: "View delivery details"    },
      { id: "change",  title: "✏️ Change Quantity",   description: "Update daily packets"     },
      { id: "profile", title: "📍 Update Address",    description: "Change delivery location" },
      { id: "stop",    title: "⏸ Pause Delivery",     description: "Temporarily stop milk"    }
    ]
  } else {
    rows = [
      { id: "resume",  title: "▶️ Resume Delivery",  description: `Continue with ${sub.quantity} packet/day` },
      { id: "change",  title: "✏️ Change & Resume",  description: "Pick new quantity and restart"            },
      { id: "profile", title: "📍 Update Address",   description: "Change delivery location"                 }
    ]
  }

  await sendList(pid, phone, `🥛 *${name}*\n\nHow can we help you today?`, rows, "View Options")
}

async function sendQtyMenu(pid, phone, prefix, maxQty = 5) {
  const limit = Math.min(maxQty, 5)
  const rows = Array.from({ length: limit }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    title: `${i + 1} Packet${i + 1 > 1 ? "s" : ""}`,
    description: `${i + 1} packet${i + 1 > 1 ? "s" : ""} delivered daily`
  }))
  await sendList(pid, phone, "🥛 *Select Daily Quantity*\n\nHow many milk packets per day?", nav(rows), "Choose")
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

// after_addr=true means: go to quantity selection after address is saved (new subscription flow)
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

async function afterAddressComplete(pid, phone, cId, vId, profile, settings, afterAddr) {
  if (afterAddr) {
    const maxQty = settings.max_quantity_per_order || 5
    await sendQtyMenu(pid, phone, "sub", maxQty)
    await setState(phone, "sub_qty", vId)
  } else {
    const sub = await getSubscription(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile)
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

  const customer  = await getCustomer(phone)
  const state     = await getState(phone)
  const settings  = await getSettings(vendor.vendor_id)
  const profile   = await getProfile(vendor.vendor_id)

  console.log("👤 Customer:", customer.customer_id, "| State:", state?.state || "none")

  let input = null
  if (msg.type === "text")        input = msg.text?.body?.trim()
  if (msg.type === "interactive") input = msg.interactive?.list_reply?.id
  if (!input) return

  const inputLower = input.toLowerCase()
  const vId = vendor.vendor_id
  const cId = customer.customer_id

  /* ── Global: greetings and menu reset ── */

  const isReset  = ["hi", "hello", "start"].includes(inputLower)
  const isMenuNav = inputLower === "menu"

  if (!state || isReset || isMenuNav) {
    const sub  = await getSubscription(cId, vId)
    const addr = await getAddress(cId, vId)
    const name = profile?.business_name || "Milk Service"

    if (!state || isReset) {
      const welcome = sub?.status === "active"
        ? `👋 *Welcome back!*\n\nYour delivery: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}/day*\n📍 ${formatAddress(addr)}`
        : `👋 *Welcome to ${name}!*\n\nFresh milk delivered to your doorstep every day. 🥛`
      await sendText(pid, phone, welcome)
    }

    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, sub, profile)
    return
  }

  /* ── Menu state ── */

  if (state.state === "menu") {
    const sub = await getSubscription(cId, vId)

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
      await sendQtyMenu(pid, phone, "sub", maxQty)
      await setState(phone, "sub_qty", vId)
      return
    }

    if (input === "view") {
      if (!sub) {
        await sendMainMenu(pid, phone, sub, profile)
        return
      }
      const addr  = await getAddress(cId, vId)
      const price = settings.price_per_unit || 0
      let text = `📋 *Your Subscription*\n\n`
      text += `🥛 Quantity: *${sub.quantity} packet${sub.quantity > 1 ? "s" : ""}* per day\n`
      if (price > 0) {
        text += `💰 Rate: ₹${price} per packet\n`
        text += `📅 Monthly estimate: ₹${sub.quantity * price * 30}\n`
      }
      text += `📍 Address: ${formatAddress(addr)}\n`
      text += `✅ Status: Active`
      await sendText(pid, phone, text)
      await sendMainMenu(pid, phone, sub, profile)
      return
    }

    if (input === "change") {
      const maxQty = settings.max_quantity_per_order || 5
      await sendQtyMenu(pid, phone, "chg", maxQty)
      await setState(phone, "chg_qty", vId)
      return
    }

    if (input === "profile") {
      const addr = await getAddress(cId, vId)
      if (addr) await sendText(pid, phone, `📍 *Current Address:* ${formatAddress(addr)}\n\nSelect a new address below:`)
      await startAddressFlow(pid, phone, vendor, settings, false)
      return
    }

    if (input === "stop") {
      await pool.query(
        "UPDATE subscriptions SET status='inactive' WHERE customer_id=$1 AND vendor_id=$2",
        [cId, vId]
      )
      await sendText(pid, phone, `⏸ *Delivery Paused*\n\nYour milk delivery has been paused.\nYou can resume anytime from the menu. 🥛`)
      const s = await getSubscription(cId, vId)
      await setState(phone, "menu", vId)
      await sendMainMenu(pid, phone, s, profile)
      return
    }

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
      await sendMainMenu(pid, phone, s, profile)
      return
    }

    // Unrecognized tap/text in menu — redisplay menu
    await sendMainMenu(pid, phone, sub, profile)
    return
  }

  /* ── Quantity selection ── */

  if (state.state === "sub_qty" || state.state === "chg_qty") {
    const parts = input.split("_")
    const qty   = parseInt(parts[parts.length - 1])

    if (isNaN(qty) || qty < 1) {
      await sendText(pid, phone, "⚠️ Please choose a quantity from the list.")
      const maxQty = settings.max_quantity_per_order || 5
      await sendQtyMenu(pid, phone, state.state === "sub_qty" ? "sub" : "chg", maxQty)
      return
    }

    await saveSubscription(cId, vId, qty)
    const addr  = await getAddress(cId, vId)
    const price = settings.price_per_unit || 0

    let confirm = `✅ *Subscription Confirmed!*\n\n`
    confirm += `🥛 *${qty} packet${qty > 1 ? "s" : ""}* delivered every day\n`
    if (price > 0) confirm += `💰 ₹${price * qty}/day\n`
    confirm += `📍 ${formatAddress(addr)}\n\n`
    confirm += `Delivery starts tomorrow! 🎉`

    await sendText(pid, phone, confirm)
    const s = await getSubscription(cId, vId)
    await setState(phone, "menu", vId)
    await sendMainMenu(pid, phone, s, profile)
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
        // No blocks configured — skip to flat number
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
    const blockId    = input.split("_")[1]
    const temp       = { ...state.temp_data, blockId }
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
      await sendText(pid, phone, "⚠️ Address is too long. Please keep it under 200 characters.")
      return
    }
    await saveManual(cId, vId, address)
    await sendText(pid, phone, "✅ *Address Saved!*\n\nYour delivery address has been updated.")
    await afterAddressComplete(pid, phone, cId, vId, profile, settings, state.temp_data?.after_addr)
    return
  }

  /* ── Fallback: reset to menu ── */

  const sub = await getSubscription(cId, vId)
  await setState(phone, "menu", vId)
  await sendMainMenu(pid, phone, sub, profile)
}

module.exports = handleCustomerBot
