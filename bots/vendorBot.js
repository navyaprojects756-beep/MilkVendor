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

  console.log("WhatsApp Error")
  console.log(err.response?.data || err.message)

 }

}


/* ---------------- MAIN VENDOR BOT ---------------- */

async function handleVendorBot(msg, phoneNumberId){

 const phone = msg.from

 console.log("📩 Vendor message from:", phone)

 if(msg.type !== "text") return

 const text = msg.text.body.toLowerCase()

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
   "You are not registered as vendor. Please contact admin."
  )

  return
 }

 console.log("✅ Vendor found:", vendor.vendor_id)

 /* ---------------- HANDLE COMMANDS ---------------- */

 if(text === "hi" || text === "menu"){

  /* Generate secure token */
  const token = generateVendorToken(vendor.vendor_id)

  /* Dashboard link */
  const link = `${process.env.APP_BASE_URL}/vendor-dashboard.html?token=${token}`

  console.log("🔗 Dashboard link:", link)

  await sendText(
   phoneNumberId,
   phone,
   `Welcome ${vendor.vendor_name || "Vendor"} 👋

Open your dashboard:
${link}`
  )

 }

}

module.exports = handleVendorBot