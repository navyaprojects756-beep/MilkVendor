const axios = require("axios")
const pool = require("../db")

const { generateVendorToken } = require("../services/vendorAuth")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

/* ---------------- SEND MESSAGE ---------------- */

async function sendText(phoneNumberId, phone, text){

 try{

 await axios.post(
 `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
 {
  messaging_product:"whatsapp",
  to:phone,
  type:"text",
  text:{body:text}
 },
 {
  headers:{
   Authorization:`Bearer ${WHATSAPP_TOKEN}`,
   "Content-Type":"application/json"
  }
 }
 )

 }
 catch(err){

  console.log("❌ WhatsApp Error")
  console.log(err.response?.data || err.message)

 }

}

/* ---------------- GENERATE ORDERS ---------------- */

async function generateOrders(vendorId){

 console.log("⚙️ Generating orders for vendor:", vendorId)

 /* delete existing tomorrow orders */
 await pool.query(
 `DELETE FROM orders
  WHERE vendor_id=$1
  AND order_date=CURRENT_DATE + 1`,
 [vendorId]
 )

 /* insert new orders from subscriptions */
 await pool.query(
 `
 INSERT INTO orders(customer_id,vendor_id,order_date,quantity)
 SELECT customer_id,vendor_id,CURRENT_DATE + 1,quantity
 FROM subscriptions
 WHERE vendor_id=$1
 AND status='active'
 `,
 [vendorId]
 )

 console.log("✅ Orders generated")
}

/* ---------------- MAIN VENDOR BOT ---------------- */

async function handleVendorBot(msg, phoneNumberId){

 const phone = msg.from

 console.log("\n📩 Vendor message from:", phone)

 if(msg.type !== "text") return

 const text = msg.text.body.toLowerCase().trim()

 console.log("💬 Vendor text:", text)

 /* ---------------- FETCH VENDOR ---------------- */

 const vendorRes = await pool.query(
  "SELECT * FROM vendors WHERE phone=$1",
  [phone]
 )

 const vendor = vendorRes.rows[0]

 if(!vendor){

  console.log("❌ Vendor not found")

  await sendText(
   phoneNumberId,
   phone,
   "❌ You are not registered as vendor.\nPlease contact admin."
  )

  return
 }

 /* ---------------- CHECK STATUS ---------------- */

 if(!vendor.is_active){

  await sendText(
   phoneNumberId,
   phone,
   "⛔ Your account is currently inactive.\nPlease contact admin."
  )

  return
 }

 console.log("✅ Vendor found:", vendor.vendor_id)

 /* ---------------- FETCH SETTINGS ---------------- */

 const settingsRes = await pool.query(
  "SELECT * FROM vendor_settings WHERE vendor_id=$1",
  [vendor.vendor_id]
 )

 const settings = settingsRes.rows[0] || {}

 /* ---------------- COMMANDS ---------------- */

 if(text === "hi" || text === "menu"){

  const token = generateVendorToken(vendor.vendor_id)

  const link = `${process.env.APP_BASE_URL}?token=${token}`

  await sendText(
   phoneNumberId,
   phone,
   `👋 Welcome ${vendor.vendor_name || "Vendor"}

📊 Dashboard:
${link}

⚙️ Commands:
- menu → open dashboard
- generate → generate tomorrow orders
- status → view settings`
  )

 }

 /* ---------------- GENERATE ORDERS ---------------- */

 else if(text === "generate"){

  await generateOrders(vendor.vendor_id)

  await sendText(
   phoneNumberId,
   phone,
   "✅ Tomorrow orders generated successfully!"
  )

 }

 /* ---------------- STATUS ---------------- */

 else if(text === "status"){

  await sendText(
   phoneNumberId,
   phone,
   `📊 Vendor Status

Name: ${vendor.vendor_name || "Vendor"}
Active: ${vendor.is_active ? "Yes" : "No"}

Settings:
Apartments: ${settings.allow_apartments !== false ? "Enabled" : "Disabled"}
Houses: ${settings.allow_houses !== false ? "Enabled" : "Disabled"}`
  )

 }

 /* ---------------- HELP ---------------- */

 else{

  await sendText(
   phoneNumberId,
   phone,
   `❓ Unknown command

Try:
menu
generate
status`
  )

 }

}

module.exports = handleVendorBot