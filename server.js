const cors = require("cors")
const path = require("path")
require("dotenv").config()
const express = require("express")

const app = express()
app.set("etag", false)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  res.setHeader("Pragma", "no-cache")
  res.setHeader("Expires", "0")
  res.setHeader("Surrogate-Control", "no-store")
  next()
})
app.use(cors({
  origin: process.env.CORS_ORIGIN,
  credentials: true
}))
require("./cron/orderCron")

app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), {
  maxAge: "7d"
}))


// Bots
const handleCustomerBot = require("./bots/customerBot")
const handleVendorBot = require("./bots/vendorBot")
const vendorDashboard = require("./routes/vendorDashboard")

/* ---------------- MIDDLEWARE ---------------- */

app.use(express.json({ limit: "10mb" }))
app.use(express.static("public"))
app.use("/vendor", (req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
})
app.use("/vendor", vendorDashboard)

/* ---------------- CONFIG ---------------- */

const PORT = process.env.PORT || 3000
const VERIFY_TOKEN = process.env.VERIFY_TOKEN
const MAIN_VENDOR_PHONE_ID = process.env.MAIN_VENDOR_PHONE_NUMBER_ID

const processedMessages = new Set()

/* ---------------- HEALTH CHECK ---------------- */

app.get("/", (req,res)=>{
 res.send("✅ Milk Bot Running")
})

/* ---------------- WEBHOOK VERIFY ---------------- */

app.get("/webhook",(req,res)=>{

 console.log("🔵 Webhook verification request")

 const mode=req.query["hub.mode"]
 const token=req.query["hub.verify_token"]
 const challenge=req.query["hub.challenge"]

 if(mode==="subscribe" && token===VERIFY_TOKEN){
   console.log("✅ Webhook verified")
   return res.status(200).send(challenge)
 }

 console.log("❌ Webhook verification failed")
 res.sendStatus(403)

})

/* ---------------- WEBHOOK MESSAGE HANDLER ---------------- */

app.post("/webhook",async(req,res)=>{

 // Always respond immediately
 res.sendStatus(200)

 try{

 const value=req.body?.entry?.[0]?.changes?.[0]?.value

 if(!value || !value.messages){
   console.log("❌ Invalid webhook payload")
   return
 }

 const msg=value.messages[0]
 const phoneNumberId=value.metadata.phone_number_id

 /* ---------------- DUPLICATE PROTECTION ---------------- */

 if(processedMessages.has(msg.id)){
   console.log("⚠ Duplicate message skipped:", msg.id)
   return
 }

 processedMessages.add(msg.id)

 /* cleanup (prevent memory leak) */
 setTimeout(()=>processedMessages.delete(msg.id), 60000)

 /* ---------------- LOGGING ---------------- */

 console.log("\n==============================")
 console.log("📩 Incoming Message")
 console.log("From:", msg.from)
 console.log("Type:", msg.type)
 console.log("Phone ID:", phoneNumberId)

 if(msg.type==="text"){
   console.log("Text:", msg.text.body)
 }

 if(msg.type==="interactive"){
   console.log("Interactive:", msg.interactive?.list_reply?.id)
 }

 /* ---------------- ROUTING ---------------- */

 if(phoneNumberId===MAIN_VENDOR_PHONE_ID){

   console.log("➡ Vendor Bot")

   await handleVendorBot(msg,phoneNumberId)

 }else{

   console.log("➡ Customer Bot")

   await handleCustomerBot(msg,phoneNumberId)

 }

 }
 catch(err){

 console.log("🔥 Webhook error:", err.message)

 }

})

/* ---------------- GLOBAL ERROR HANDLER ---------------- */

process.on("unhandledRejection",(err)=>{
 console.log("❌ Unhandled Promise:", err)
})

process.on("uncaughtException",(err)=>{
 console.log("❌ Uncaught Exception:", err)
})

/* ---------------- SERVER START ---------------- */

app.listen(PORT,()=>{

 console.log("================================")
 console.log("🚀 Milk WhatsApp Bot Running")
 console.log("Port:",PORT)
 console.log("Vendor Phone ID:",MAIN_VENDOR_PHONE_ID)
 console.log("================================")

})