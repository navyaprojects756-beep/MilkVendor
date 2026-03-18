const axios = require("axios")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

async function sendText(phoneNumberId,phone,text){

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

async function handleVendorBot(msg,phoneNumberId){

 const phone=msg.from

 if(msg.type==="text"){

 const text=msg.text.body.toLowerCase()

 if(text==="hi"){

  await sendText(
   phoneNumberId,
   phone,
   "Vendor Dashboard link will be generated here"
  )

 }

 }

}

module.exports = handleVendorBot