require("dotenv").config()
require("./cron/orderCron")
const express = require("express")


// Bots
const handleCustomerBot = require("./bots/customerBot")
const handleVendorBot = require("./bots/vendorBot")
const vendorDashboard = require("./routes/vendorDashboard")


const app = express()
app.use(express.static("public"))
app.use("/vendor", vendorDashboard)
app.use(express.json())

const PORT = process.env.PORT || 3000
const VERIFY_TOKEN = process.env.VERIFY_TOKEN
const MAIN_VENDOR_PHONE_ID = process.env.MAIN_VENDOR_PHONE_NUMBER_ID


/* ---------------- WEBHOOK VERIFY ---------------- */

app.get("/webhook",(req,res)=>{

 console.log("🔵 Webhook verification request received")

 const mode=req.query["hub.mode"]
 const token=req.query["hub.verify_token"]
 const challenge=req.query["hub.challenge"]

 console.log("mode:",mode)
 console.log("token:",token)

 if(mode==="subscribe" && token===VERIFY_TOKEN){

   console.log("✅ Webhook verified successfully")

   return res.status(200).send(challenge)

 }

 console.log("❌ Webhook verification failed")

 res.sendStatus(403)

})


/* ---------------- WEBHOOK MESSAGE HANDLER ---------------- */

app.post("/webhook",async(req,res)=>{

 console.log("\n==============================")
 console.log("📩 Incoming WhatsApp Webhook")
 console.log("==============================")

 // Respond immediately to avoid WhatsApp retries
 res.sendStatus(200)

 try{

 const body=req.body

 console.log("📦 Webhook payload received")

 // Save payload for debugging (optional)
 // require("fs").writeFileSync("webhook-log.json",JSON.stringify(body,null,2))

 const value=body?.entry?.[0]?.changes?.[0]?.value

 if(!value){

   console.log("❌ No value object found in webhook")

   return

 }

 if(!value.messages){

   console.log("❌ No messages found in webhook")

   return

 }

 const msg=value.messages[0]

 const phoneNumberId=value.metadata.phone_number_id

 console.log("📱 phone_number_id:",phoneNumberId)

 console.log("👤 message from:",msg.from)

 console.log("💬 message type:",msg.type)

 if(msg.type==="text"){
   console.log("📝 text message:",msg.text.body)
 }

 if(msg.type==="interactive"){
   console.log("📋 interactive reply:",msg.interactive?.list_reply?.id)
 }

 /* ---------------- ROUTE BOT ---------------- */

 if(phoneNumberId===MAIN_VENDOR_PHONE_ID){

   console.log("➡ Routing to VENDOR BOT")

   await handleVendorBot(msg,phoneNumberId)

 }else{

   console.log("➡ Routing to CUSTOMER BOT")

   await handleCustomerBot(msg,phoneNumberId)

 }

 }
 catch(err){

 console.log("🔥 Webhook processing error")

 console.log(err)

 }

})



/* ---------------- SERVER START ---------------- */

app.listen(PORT,()=>{

 console.log("================================")
 console.log("🚀 Milk WhatsApp Bot Server Running")
 console.log("Port:",PORT)
 console.log("Vendor Phone ID:",MAIN_VENDOR_PHONE_ID)
 console.log("================================")

})