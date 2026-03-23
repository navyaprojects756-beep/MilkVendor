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
 { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`,"Content-Type":"application/json"} }
 )
 }catch(err){
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
   action:{button:"Select",sections:[{title:"Menu",rows}]}
  }
 })
}

/* ---------------- DATABASE ---------------- */

async function getCustomer(phone){
 const r=await pool.query("SELECT * FROM customers WHERE phone=$1",[phone])
 if(r.rows.length) return r.rows[0]
 const i=await pool.query("INSERT INTO customers(phone) VALUES($1) RETURNING *",[phone])
 return i.rows[0]
}

async function getVendor(phoneNumberId){
 const r=await pool.query("SELECT * FROM vendors WHERE phone_number_id=$1",[phoneNumberId])
 return r.rows[0]
}

async function getSubscription(customerId,vendorId){
 const r=await pool.query(
 `SELECT * FROM subscriptions 
  WHERE customer_id=$1 AND vendor_id=$2 AND status='active'`,
 [customerId,vendorId]
 )
 return r.rows[0]||null
}

/* ✅ SAVE SUBSCRIPTION */

async function saveSubscription(customerId, vendorId, quantity){

 await pool.query(`
 INSERT INTO subscriptions (customer_id, vendor_id, quantity, status)
 VALUES ($1, $2, $3, 'active')
 ON CONFLICT (customer_id, vendor_id)
 DO UPDATE SET quantity=$3, status='active'
 `,[customerId, vendorId, quantity])

}

/* ---------------- ADDRESS ---------------- */

async function getAddress(customerId,vendorId){
 const r = await pool.query(`
 SELECT cv.*, a.name as apartment, b.block_name
 FROM customer_vendor_profile cv
 LEFT JOIN apartments a ON cv.apartment_id=a.apartment_id
 LEFT JOIN apartment_blocks b ON cv.block_id=b.block_id
 WHERE cv.customer_id=$1 AND cv.vendor_id=$2
 `,[customerId,vendorId])
 return r.rows[0] || null
}

async function saveApartmentAddress(customerId,vendorId,aptId,blockId,flat){
 await pool.query(`
 INSERT INTO customer_vendor_profile
 (customer_id,vendor_id,address_type,apartment_id,block_id,flat_number)
 VALUES($1,$2,'apartment',$3,$4,$5)
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET apartment_id=$3,block_id=$4,flat_number=$5
 `,[customerId,vendorId,aptId,blockId,flat])
}

async function saveManualAddress(customerId,vendorId,address){
 await pool.query(`
 INSERT INTO customer_vendor_profile
 (customer_id,vendor_id,address_type,manual_address)
 VALUES($1,$2,'house',$3)
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET manual_address=$3
 `,[customerId,vendorId,address])
}

/* ---------------- STATE ---------------- */

async function getState(phone){
 const r=await pool.query("SELECT * FROM conversation_state WHERE phone=$1",[phone])
 return r.rows[0]||null
}

async function setState(phone,state,vendorId,temp={}){
 await pool.query(`
 INSERT INTO conversation_state(phone,state,selected_vendor_id,temp_data)
 VALUES($1,$2,$3,$4)
 ON CONFLICT(phone)
 DO UPDATE SET state=$2,selected_vendor_id=$3,temp_data=$4
 `,[phone,state,vendorId,temp])
}

/* ---------------- ADDRESS FLOW ---------------- */

async function startAddressFlow(phoneNumberId,phone,vendor){
 await sendList(phoneNumberId,phone,"Select Address Type",[
  {id:"apt",title:"Apartment"},
  {id:"house",title:"Individual House"}
 ])
 await setState(phone,"await_address_type",vendor.vendor_id)
}

/* ---------------- MENUS ---------------- */

async function sendMainMenu(phone,subscription,phoneNumberId){

 let rows=[]

 if(!subscription){
 rows=[{id:"subscribe",title:"Subscribe Daily Milk"}]
 }else{
 rows=[
 {id:"view",title:"View Subscription"},
 {id:"change",title:"Change Quantity"},
 {id:"profile",title:"Profile"},
 {id:"stop",title:"Stop Subscription"},
 {id:"tomorrow",title:"Extra Milk Tomorrow"}
 ]
 }

 await sendList(phoneNumberId,phone,"Milk Service Menu",rows)
}

/* ---------------- MENU ---------------- */

async function handleMenu(phone,id,customer,vendor,phoneNumberId){

 const address = await getAddress(customer.customer_id,vendor.vendor_id)

 if(id==="subscribe" && !address){
 await sendText(phoneNumberId,phone,"Please add address first")
 await startAddressFlow(phoneNumberId,phone,vendor)
 return
 }

 if(id==="profile"){
 await startAddressFlow(phoneNumberId,phone,vendor)
 return
 }

 if(id==="subscribe"){
 await sendQuantityMenu(phone,"sub",phoneNumberId)
 await setState(phone,"await_sub_qty",vendor.vendor_id)
 }

}

/* ---------------- QUANTITY ---------------- */

async function sendQuantityMenu(phone,prefix,phoneNumberId){
 const rows=[
 {id:`${prefix}_1`,title:"1 Packet"},
 {id:`${prefix}_2`,title:"2 Packets"},
 {id:`${prefix}_3`,title:"3 Packets"},
 {id:`${prefix}_4`,title:"4 Packets"},
 {id:`${prefix}_5`,title:"5 Packets"}
 ]
 await sendList(phoneNumberId,phone,"Select Quantity",rows)
}

/* ---------------- STATE HANDLER ---------------- */

async function handleState(phone,id,customer,state,vendor,phoneNumberId){

 const vendorId=vendor.vendor_id

 /* ✅ SUBSCRIPTION */

 if(state.state==="await_sub_qty"){

 const qty=parseInt(id.split("_")[1])

 if(!qty){
 await sendText(phoneNumberId,phone,"Invalid selection")
 return
 }

 await saveSubscription(customer.customer_id,vendorId,qty)

 await sendText(phoneNumberId,phone,`Subscription started with ${qty} packets ✅`)

 await setState(phone,"menu",vendorId)

 const sub=await getSubscription(customer.customer_id,vendorId)

 await sendMainMenu(phone,sub,phoneNumberId)

 return
 }

 /* ADDRESS FLOW */

 if(state.state==="await_address_type"){
 if(id==="apt"){
 const apts=await pool.query("SELECT * FROM apartments WHERE vendor_id=$1",[vendorId])
 const rows=apts.rows.map(a=>({id:`apt_${a.apartment_id}`,title:a.name}))
 rows.push({id:"house",title:"Other"})
 await sendList(phoneNumberId,phone,"Select Apartment",rows)
 await setState(phone,"await_apartment",vendorId)
 }else{
 await sendText(phoneNumberId,phone,"Enter your address")
 await setState(phone,"await_manual",vendorId)
 }
 return
 }

 if(state.state==="await_apartment"){
 if(id==="house"){
 await sendText(phoneNumberId,phone,"Enter your address")
 await setState(phone,"await_manual",vendorId)
 return
 }

 const aptId=id.split("_")[1]

 const blocks=await pool.query("SELECT * FROM apartment_blocks WHERE apartment_id=$1",[aptId])
 const rows=blocks.rows.map(b=>({id:`block_${b.block_id}`,title:b.block_name}))

 await sendList(phoneNumberId,phone,"Select Block",rows)

 await setState(phone,"await_block",vendorId,{aptId})
 return
 }

 if(state.state==="await_block"){
 const blockId=id.split("_")[1]
 await sendText(phoneNumberId,phone,"Enter flat number")
 await setState(phone,"await_flat",vendorId,{...state.temp_data,blockId})
 return
 }

 if(state.state==="await_flat"){
 const t=state.temp_data

 await saveApartmentAddress(customer.customer_id,vendorId,t.aptId,t.blockId,id)

 await sendText(phoneNumberId,phone,"Address saved ✅")

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,null,phoneNumberId)

 return
 }

 if(state.state==="await_manual"){
 await saveManualAddress(customer.customer_id,vendorId,id)

 await sendText(phoneNumberId,phone,"Address saved ✅")

 await setState(phone,"menu",vendorId)

 await sendMainMenu(phone,null,phoneNumberId)

 return
 }

}

/* ---------------- MAIN ---------------- */

async function handleCustomerBot(msg,phoneNumberId){

 if(processedMessages.has(msg.id)) return
 processedMessages.add(msg.id)

 const phone=msg.from

 const vendor=await getVendor(phoneNumberId)
 if(!vendor || !vendor.is_active) return

 const customer=await getCustomer(phone)
 const state=await getState(phone)

 let messageId=null

 if(msg.type==="text") messageId=msg.text.body.toLowerCase()
 if(msg.type==="interactive") messageId=msg.interactive?.list_reply?.id

 if(!state || messageId==="hi"){

 const addr=await getAddress(customer.customer_id,vendor.vendor_id)

 if(!addr){
 await startAddressFlow(phoneNumberId,phone,vendor)
 return
 }

 await setState(phone,"menu",vendor.vendor_id)

 const sub=await getSubscription(customer.customer_id,vendor.vendor_id)

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