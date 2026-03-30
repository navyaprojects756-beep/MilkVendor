const pool = require("../db")
const axios = require("axios")
const { generateVendorToken }    = require("../services/vendorAuth")
const { generateOrdersForVendor } = require("../services/orderGenerator")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

/* ─── SEND ─────────────────────────────────────────────── */

async function sendText(phoneNumberId, phone, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    )
  } catch (err) {
    console.log("❌ WhatsApp Error:", err.response?.data || err.message)
  }
}

/* ─── MAIN VENDOR BOT ──────────────────────────────────── */

async function handleVendorBot(msg, phoneNumberId) {
  const phone = msg.from

  console.log("\n📩 Vendor message from:", phone)

  if (msg.type !== "text") return

  const text = msg.text.body.toLowerCase().trim()

  console.log("💬 Vendor text:", text)

  /* ── Fetch vendor ── */

  const vendorRes = await pool.query("SELECT * FROM vendors WHERE phone=$1", [phone])
  const vendor = vendorRes.rows[0]

  if (!vendor) {
    console.log("❌ Vendor not found:", phone)
    await sendText(phoneNumberId, phone, "❌ You are not registered as a vendor.\nPlease contact admin.")
    return
  }

  if (!vendor.is_active) {
    await sendText(phoneNumberId, phone, "⛔ Your account is currently inactive.\nPlease contact admin.")
    return
  }

  console.log("✅ Vendor found:", vendor.vendor_id)

  /* ── Fetch settings ── */

  const settingsRes = await pool.query("SELECT * FROM vendor_settings WHERE vendor_id=$1", [vendor.vendor_id])
  const settings = settingsRes.rows[0] || {}

  const profileRes = await pool.query("SELECT * FROM vendor_profile WHERE vendor_id=$1", [vendor.vendor_id])
  const profile = profileRes.rows[0] || {}

  /* ── Commands ── */

  if (text === "hi" || text === "menu") {
    const adminToken    = generateVendorToken(vendor.vendor_id, "admin")
    const deliveryToken = generateVendorToken(vendor.vendor_id, "delivery")
    const t             = Date.now()
    const adminLink    = `${process.env.APP_BASE_URL}?token=${adminToken}&t=${t}`
    const deliveryLink = `${process.env.APP_BASE_URL}?token=${deliveryToken}&t=${t}`

    await sendText(
      phoneNumberId,
      phone,
      `👋 Welcome, ${vendor.vendor_name || "Vendor"}!\n\n` +
      `🔐 *Admin Link* (full access):\n${adminLink}\n\n` +
      `🚚 *Delivery Boy Link* (orders only):\n${deliveryLink}\n\n` +
      `_(Links valid for 2 hours)_\n\n` +
      `⚙️ *Commands:*\n` +
      `• menu — get dashboard links\n` +
      `• generate — create tomorrow's orders\n` +
      `• status — view current settings`
    )
    return
  }

  if (text === "generate") {
    try {
      await generateOrdersForVendor(vendor.vendor_id)

      const ordersRes = await pool.query(
        "SELECT COUNT(*) AS total FROM orders WHERE vendor_id=$1 AND order_date=CURRENT_DATE + 1",
        [vendor.vendor_id]
      )
      const total = ordersRes.rows[0]?.total || 0

      await sendText(
        phoneNumberId,
        phone,
        `✅ *Orders Generated!*\n\n` +
        `📦 Tomorrow's orders: *${total}*\n` +
        `📅 Date: ${new Date(Date.now() + 86400000).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}\n\n` +
        `Open dashboard to view details.`
      )
    } catch (err) {
      console.log("❌ Order generation failed:", err.message)
      await sendText(phoneNumberId, phone, "❌ Failed to generate orders. Please try again.")
    }
    return
  }

  if (text === "status") {
    const price       = settings.price_per_unit ? `₹${settings.price_per_unit}` : "Not set"
    const autoTime    = settings.auto_generate_time
      ? String(settings.auto_generate_time).slice(0, 5)
      : "Not set"
    const orderWindow = settings.order_window_enabled
      ? `${String(settings.order_accept_start || "").slice(0, 5)} – ${String(settings.order_accept_end || "").slice(0, 5)}`
      : "Always open"

    const subsRes = await pool.query(
      "SELECT COUNT(*) AS total FROM subscriptions WHERE vendor_id=$1 AND status='active'",
      [vendor.vendor_id]
    )
    const activeSubs = subsRes.rows[0]?.total || 0

    await sendText(
      phoneNumberId,
      phone,
      `📊 *Vendor Status*\n\n` +
      `🏪 ${profile.business_name || vendor.vendor_name || "Your Business"}\n` +
      `✅ Account: Active\n\n` +
      `📦 Active subscriptions: *${activeSubs}*\n` +
      `💰 Price per packet: ${price}\n` +
      `⏰ Order window: ${orderWindow}\n` +
      `🔄 Auto-generate time: ${autoTime}\n\n` +
      `Address types accepted:\n` +
      `🏢 Apartments: ${settings.allow_apartments !== false ? "Yes" : "No"}\n` +
      `🏠 Houses: ${settings.allow_houses !== false ? "Yes" : "No"}`
    )
    return
  }

  /* ── Default help ── */

  await sendText(
    phoneNumberId,
    phone,
    `❓ *Unknown command*\n\nAvailable commands:\n` +
    `• menu — open dashboard\n` +
    `• generate — create tomorrow's orders\n` +
    `• status — view settings`
  )
}

module.exports = handleVendorBot
