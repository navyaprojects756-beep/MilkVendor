const pool = require("../db")
const axios = require("axios")
const { generateVendorToken } = require("../services/vendorAuth")
const { generateOrdersForVendor } = require("../services/orderGenerator")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

function getISTDateStr(offsetDays = 0) {
  const now = new Date()
  const istNow = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
  const date = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function formatISTDateLabel(dateStr) {
  const [yr, mo, dy] = String(dateStr).split("-").map(Number)
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0)))
}

async function sendText(phoneNumberId, phone, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    )
  } catch (err) {
    console.log("WhatsApp Error:", err.response?.data || err.message)
  }
}

async function handleVendorBot(msg, phoneNumberId) {
  const phone = msg.from

  console.log("\nVendor message from:", phone)

  if (msg.type !== "text") return

  const text = String(msg.text?.body || "").toLowerCase().trim()

  console.log("Vendor text:", text)

  const vendorRes = await pool.query("SELECT * FROM vendors WHERE phone=$1", [phone])
  const vendor = vendorRes.rows[0]

  if (!vendor) {
    console.log("Vendor not found:", phone)
    await sendText(phoneNumberId, phone, "You are not registered as a vendor. Please contact admin.")
    return
  }

  if (!vendor.is_active) {
    await sendText(phoneNumberId, phone, "Your account is currently inactive. Please contact admin.")
    return
  }

  console.log("Vendor found:", vendor.vendor_id)

  const settingsRes = await pool.query("SELECT * FROM vendor_settings WHERE vendor_id=$1", [vendor.vendor_id])
  const settings = settingsRes.rows[0] || {}

  const profileRes = await pool.query("SELECT * FROM vendor_profile WHERE vendor_id=$1", [vendor.vendor_id])
  const profile = profileRes.rows[0] || {}

  if (text === "hi" || text === "menu") {
    try {
      const adminToken = generateVendorToken(vendor.vendor_id, "admin")
      const deliveryToken = generateVendorToken(vendor.vendor_id, "delivery")
      const t = Date.now()
      const adminLink = `${process.env.APP_BASE_URL}dashboard?token=${adminToken}&t=${t}`
      const deliveryLink = `${process.env.APP_BASE_URL}dashboard?token=${deliveryToken}&t=${t}`

      await sendText(
        phoneNumberId,
        phone,
        `Welcome, ${vendor.vendor_name || "Vendor"}!\n\n` +
          `Admin Link (full access):\n${adminLink}\n\n` +
          `Delivery Link (orders only):\n${deliveryLink}\n\n` +
          `(Links valid for 2 hours)\n\n` +
          `Commands:\n` +
          `- menu : get dashboard links\n` +
          `- generate : create tomorrow's orders\n` +
          `- status : view current settings`
      )
    } catch (err) {
      console.log("Vendor menu link error:", err.message)
      await sendText(
        phoneNumberId,
        phone,
        "Dashboard links are not available right now because JWT_SECRET is missing in the server configuration. Please update the server .env and try again."
      )
    }
    return
  }

  if (text === "generate") {
    try {
      await generateOrdersForVendor(vendor.vendor_id)

      const tomorrowStr = getISTDateStr(1)
      const ordersRes = await pool.query(
        "SELECT COUNT(*) AS total FROM orders WHERE vendor_id=$1 AND order_date=$2::date",
        [vendor.vendor_id, tomorrowStr]
      )
      const total = ordersRes.rows[0]?.total || 0

      await sendText(
        phoneNumberId,
        phone,
        `Orders Generated!\n\n` +
          `Tomorrow's orders: ${total}\n` +
          `Date: ${formatISTDateLabel(tomorrowStr)}\n\n` +
          `Open dashboard to view details.`
      )
    } catch (err) {
      console.log("Order generation failed:", err.message)
      await sendText(phoneNumberId, phone, "Failed to generate orders. Please try again.")
    }
    return
  }

  if (text === "status") {
    const price = settings.price_per_unit ? `Rs.${settings.price_per_unit}` : "Not set"
    const autoTime = settings.auto_generate_time
      ? String(settings.auto_generate_time).slice(0, 5)
      : "Not set"
    const orderWindow = settings.order_window_enabled
      ? formatWindowLabel(settings.order_accept_start, settings.order_accept_end)
      : "Always open"

    const subsRes = await pool.query(
      "SELECT COUNT(*) AS total FROM subscriptions WHERE vendor_id=$1 AND status='active'",
      [vendor.vendor_id]
    )
    const activeSubs = subsRes.rows[0]?.total || 0

    await sendText(
      phoneNumberId,
      phone,
      `Vendor Status\n\n` +
        `${profile.business_name || vendor.vendor_name || "Your Business"}\n` +
        `Account: Active\n\n` +
        `Active subscriptions: ${activeSubs}\n` +
        `Price per packet: ${price}\n` +
        `Order window: ${orderWindow}\n` +
        `Auto-generate time: ${autoTime}\n\n` +
        `Address types accepted:\n` +
        `Apartments: ${settings.allow_apartments !== false ? "Yes" : "No"}\n` +
        `Houses: ${settings.allow_houses !== false ? "Yes" : "No"}`
    )
    return
  }

  await sendText(
    phoneNumberId,
    phone,
    `Unknown command\n\nAvailable commands:\n` +
      `- menu : open dashboard\n` +
      `- generate : create tomorrow's orders\n` +
      `- status : view settings`
  )
}

module.exports = handleVendorBot
function formatWindowLabel(start, end) {
  if (!start || !end) return "Not set"
  const toMins = (t) => {
    const [h, m] = String(t).slice(0, 5).split(":").map(Number)
    return (h * 60) + m
  }
  const startMins = toMins(start)
  const endMins = toMins(end)
  if (startMins > endMins) {
    return `${String(start).slice(0, 5)} - next day ${String(end).slice(0, 5)}`
  }
  return `${String(start).slice(0, 5)} - ${String(end).slice(0, 5)}`
}
