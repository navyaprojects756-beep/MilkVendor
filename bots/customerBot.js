const axios = require("axios")
const pool = require("../db")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

const processedMessages = new Set()

/* ---------------- SEND MESSAGE ---------------- */

async function sendWhatsApp(phoneNumberId,payload){

 try{

 await axios.post(
 `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
 payload,
 {
  headers:{
   Authorization:`Bearer ${WHATSAPP_TOKEN}`,
   "Content-Type":"application/json"
  }
 })

 }
 catch(err){

  console.log("WhatsApp Error")
  console.log(err.response?.data || err.message)

 }

}

async function sendText(phoneNumberId,phone,text){

 await sendWhatsApp(phoneNumberId,{
  messaging_product:"whatsapp",
  to:phone,
  type:"text",
  text:{body:text}
 })

}

async function sendList(phoneNumberId,phone,title,rows){

 await sendWhatsApp(phoneNumberId,{
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
 })

}

/* ---------------- DATABASE ---------------- */

async function getCustomer(phone){

 const res = await pool.query(
 "SELECT * FROM customers WHERE phone=$1",
 [phone]
 )

 if(res.rows.length>0) return res.rows[0]

 const insert = await pool.query(
 "INSERT INTO customers(phone) VALUES($1) RETURNING *",
 [phone]
 )

 return insert.rows[0]

}

async function getVendor(phoneNumberId){

 const res = await pool.query(
 "SELECT * FROM vendors WHERE phone_number_id=$1",
 [phoneNumberId]
 )

 if(res.rows.length>0) return res.rows[0]

 const insert = await pool.query(
 `INSERT INTO vendors(vendor_name,phone_number_id)
 VALUES($1,$2)
 RETURNING *`,
 [`Vendor ${phoneNumberId}`,phoneNumberId]
 )

 return insert.rows[0]

}

async function getSubscription(customerId,vendorId){

 const res = await pool.query(
 `SELECT * FROM subscriptions
 WHERE customer_id=$1 AND vendor_id=$2`,
 [customerId,vendorId]
 )

 return res.rows[0] || null

}

async function getAddress(customerId,vendorId){

 const res = await pool.query(
 `SELECT address
 FROM customer_vendor_profile
 WHERE customer_id=$1 AND vendor_id=$2`,
 [customerId,vendorId]
 )

 return res.rows[0]?.address || null

}

async function saveAddress(customerId,vendorId,address){

 await pool.query(
 `INSERT INTO customer_vendor_profile(customer_id,vendor_id,address)
 VALUES($1,$2,$3)
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET address=$3,updated_at=NOW()`,
 [customerId,vendorId,address]
 )

}

/* ---------------- STATE ---------------- */

async function getState(phone){

 const res = await pool.query(
 "SELECT * FROM conversation_state WHERE phone=$1",
 [phone]
 )

 return res.rows[0] || null

}

async function setState(phone,state,vendorId){

 await pool.query(
 `INSERT INTO conversation_state(phone,state,selected_vendor_id)
 VALUES($1,$2,$3)
 ON CONFLICT(phone)
 DO UPDATE SET state=$2,selected_vendor_id=$3,updated_at=NOW()`,
 [phone,state,vendorId]
 )

}

/* ---------------- MENUS ---------------- */

async function sendMainMenu(phone,subscription,phoneNumberId){

 let rows=[]

 if(!subscription){

 rows=[
 {id:"subscribe",title:"Subscribe Daily Milk"}
 ]

 }else{

 if(subscription.status==="active"){

 rows=[
 {id:"view",title:"View Subscription"},
 {id:"change",title:"Change Quantity"},
 {id:"profile",title:"Profile"},
 {id:"stop",title:"Stop Subscription"},
 {id:"tomorrow",title:"Extra Milk Tomorrow"}
 ]

 }else{

 rows=[
 {id:"resume",title:"Resume Subscription"}
 ]

 }

 }

 await sendList(phoneNumberId,phone,"Milk Service Menu",rows)

}

async function sendQuantityMenu(phone,prefix,phoneNumberId){

 const rows=[
 {id:`${prefix}_1`,title:"1 Packet (500ml)"},
 {id:`${prefix}_2`,title:"2 Packets (1L)"},
 {id:`${prefix}_3`,title:"3 Packets"},
 {id:`${prefix}_4`,title:"4 Packets"},
 {id:`${prefix}_5`,title:"5 Packets"}
 ]

 await sendList(phoneNumberId,phone,"Select Milk Quantity",rows)

}

async function sendProfileMenu(phone,address,phoneNumberId){

 const rows=[
 {id:"edit_address",title:"Edit Address"},
 {id:"back_menu",title:"Back to Menu"}
 ]

 await sendList(
 phoneNumberId,
 phone,
 `Your Address:\n\n${address || "Not set"}`,
 rows
 )

}

/* ---------------- MENU ACTIONS ---------------- */

async function handleMenu(phone,id,customer,vendor,phoneNumberId){

 const sub = await getSubscription(customer.customer_id,vendor.vendor_id)

 if(id==="subscribe"){

 await sendQuantityMenu(phone,"sub",phoneNumberId)
 await setState(phone,"await_sub_qty",vendor.vendor_id)

 }

 else if(id==="view"){

 await sendText(
 phoneNumberId,
 phone,
 `Subscription\nQuantity: ${sub.quantity}\nStatus: ${sub.status}`
 )

 await sendMainMenu(phone,sub,phoneNumberId)

 }

 else if(id==="change"){

 await sendQuantityMenu(phone,"chg",phoneNumberId)
 await setState(phone,"await_change_qty",vendor.vendor_id)

 }

 else if(id==="profile"){

 const address = await getAddress(customer.customer_id,vendor.vendor_id)

 await setState(phone,"profile_menu",vendor.vendor_id)

 await sendProfileMenu(phone,address,phoneNumberId)

 }

 else if(id==="stop"){

 await pool.query(
 `UPDATE subscriptions
 SET status='inactive'
 WHERE customer_id=$1 AND vendor_id=$2`,
 [customer.customer_id,vendor.vendor_id]
 )

 await sendText(phoneNumberId,phone,"Subscription stopped")

 const updated = await getSubscription(customer.customer_id,vendor.vendor_id)

 await sendMainMenu(phone,updated,phoneNumberId)

 }

 else if(id==="resume"){

 await pool.query(
 `UPDATE subscriptions
 SET status='active'
 WHERE customer_id=$1 AND vendor_id=$2`,
 [customer.customer_id,vendor.vendor_id]
 )

 await sendText(phoneNumberId,phone,"Subscription resumed")

 const updated = await getSubscription(customer.customer_id,vendor.vendor_id)

 await sendMainMenu(phone,updated,phoneNumberId)

 }

 else if(id==="tomorrow"){

 await sendQuantityMenu(phone,"tom",phoneNumberId)
 await setState(phone,"await_tomorrow_qty",vendor.vendor_id)

 }

}

/* ---------------- STATE HANDLER ---------------- */

async function handleState(phone,id,customer,state,vendor,phoneNumberId){

 const vendorId = vendor.vendor_id

 if(state.state==="await_sub_qty"){

 const qty=parseInt(id.split("_")[1])

 await pool.query(
 `INSERT INTO subscriptions(customer_id,vendor_id,quantity,status)
 VALUES($1,$2,$3,'active')`,
 [customer.customer_id,vendorId,qty]
 )

 await sendText(phoneNumberId,phone,"Subscription created")

 const sub = await getSubscription(customer.customer_id,vendorId)

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 }

 else if(state.state==="await_change_qty"){

 const qty=parseInt(id.split("_")[1])

 await pool.query(
 `UPDATE subscriptions
 SET quantity=$1
 WHERE customer_id=$2 AND vendor_id=$3`,
 [qty,customer.customer_id,vendorId]
 )

 await sendText(phoneNumberId,phone,"Quantity updated")

 const sub = await getSubscription(customer.customer_id,vendorId)

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 }

 else if(state.state==="await_tomorrow_qty"){

 const qty=parseInt(id.split("_")[1])

 await pool.query(
 `INSERT INTO orders(customer_id,vendor_id,order_date,quantity)
 VALUES($1,$2,CURRENT_DATE + 1,$3)`,
 [customer.customer_id,vendorId,qty]
 )

 await sendText(phoneNumberId,phone,"Tomorrow order placed")

 const sub = await getSubscription(customer.customer_id,vendorId)

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 }

 else if(state.state==="profile_menu"){

 if(id==="edit_address"){

 await setState(phone,"await_address_update",vendorId)

 await sendText(phoneNumberId,phone,"Please enter new address")

 }

 if(id==="back_menu"){

 const sub = await getSubscription(customer.customer_id,vendorId)

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 }

 }

 else if(state.state==="await_address_update"){

 await saveAddress(customer.customer_id,vendorId,id)

 await sendText(phoneNumberId,phone,"Address updated")

 const sub = await getSubscription(customer.customer_id,vendorId)

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 }

}

/* ---------------- MAIN BOT ---------------- */

async function handleCustomerBot(msg,phoneNumberId){

 if(processedMessages.has(msg.id)) return

 processedMessages.add(msg.id)

 const phone=msg.from

 const vendor=await getVendor(phoneNumberId)
 const customer=await getCustomer(phone)
 const state=await getState(phone)

 let messageId=null

 if(msg.type==="text")
 messageId=msg.text.body.toLowerCase()

 if(msg.type==="interactive")
 messageId=msg.interactive?.list_reply?.id

 const sub=await getSubscription(customer.customer_id,vendor.vendor_id)

 if(!state || messageId==="hi" || messageId==="menu"){

 await setState(phone,"menu",vendor.vendor_id)

 await sendMainMenu(phone,sub,phoneNumberId)

 return

 }

 if(state.state==="menu"){

 await handleMenu(phone,messageId,customer,vendor,phoneNumberId)
 return

 }

 await handleState(phone,messageId,customer,state,vendor,phoneNumberId)

}

module.exports = handleCustomerBot