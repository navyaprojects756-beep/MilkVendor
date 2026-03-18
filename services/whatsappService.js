const axios = require("axios")

require("dotenv").config()

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
   Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}`,
   "Content-Type":"application/json"
  }
 })

 }
 catch(err){

  console.log(err.response?.data || err.message)

 }

}

async function sendList(phoneNumberId, phone, title, rows){

 try{

 await axios.post(
 `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
 {
  messaging_product:"whatsapp",
  to:phone,
  type:"interactive",
  interactive:{
   type:"list",
   body:{text:title},
   action:{
    button:"Select",
    sections:[
     {title:"Menu",rows}
    ]
   }
  }
 },
 {
  headers:{
   Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}`,
   "Content-Type":"application/json"
  }
 })

 }
 catch(err){

  console.log(err.response?.data || err.message)

 }

}

module.exports={
 sendText,
 sendList
}