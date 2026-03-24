const axios = require("axios")
const pool = require("../db")

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN
const processedMessages = new Set()

/* ---------------- SEND ---------------- */

async function sendWhatsApp(pid,payload){
 try{
 await axios.post(
 `https://graph.facebook.com/v18.0/${pid}/messages`,
 payload,
 { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}` } }
 )
 }catch(err){
 console.log("WhatsApp Error", err.response?.data || err.message)
 }
}

async function sendText(pid,phone,text){
 await sendWhatsApp(pid,{
  messaging_product:"whatsapp",
  to:phone,
  type:"text",
  text:{body:text}
 })
}

async function sendList(pid,phone,title,rows){
 await sendWhatsApp(pid,{
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

/* ---------------- NAV ---------------- */

function addNav(rows){
 return [...rows,{id:"menu",title:"🏠 Main Menu"}]
}

/* ---------------- DB ---------------- */

async function getCustomer(phone){
 const r=await pool.query("SELECT * FROM customers WHERE phone=$1",[phone])
 if(r.rows.length) return r.rows[0]
 return (await pool.query("INSERT INTO customers(phone) VALUES($1) RETURNING *",[phone])).rows[0]
}

async function getVendor(pid){
 return (await pool.query("SELECT * FROM vendors WHERE phone_number_id=$1",[pid])).rows[0]
}

async function getSubscription(c,v){
 return (await pool.query(
 `SELECT * FROM subscriptions WHERE customer_id=$1 AND vendor_id=$2`,
 [c,v])).rows[0]||null
}

async function saveSubscription(c,v,q){
 await pool.query(`
 INSERT INTO subscriptions(customer_id,vendor_id,quantity,status)
 VALUES($1,$2,$3,'active')
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET quantity=$3,status='active'
 `,[c,v,q])
}

/* ADDRESS */
async function getAddress(c,v){
 const r = await pool.query(`
 SELECT 
   cv.*,
   a.name as apartment_name,
   b.block_name
 FROM customer_vendor_profile cv
 LEFT JOIN apartments a ON cv.apartment_id=a.apartment_id
 LEFT JOIN apartment_blocks b ON cv.block_id=b.block_id
 WHERE cv.customer_id=$1 AND cv.vendor_id=$2
 `,[c,v])

 return r.rows[0]
}

async function saveApartment(c,v,a,b,f){
 await pool.query(`
 INSERT INTO customer_vendor_profile
 (customer_id,vendor_id,address_type,apartment_id,block_id,flat_number,manual_address)
 VALUES($1,$2,'apartment',$3,$4,$5,NULL)
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET
   address_type='apartment',
   apartment_id=$3,
   block_id=$4,
   flat_number=$5,
   manual_address=NULL
 `,[c,v,a,b,f])
}

async function saveManual(c,v,addr){
 await pool.query(`
 INSERT INTO customer_vendor_profile
 (customer_id,vendor_id,address_type,manual_address,apartment_id,block_id,flat_number)
 VALUES($1,$2,'house',$3,NULL,NULL,NULL)
 ON CONFLICT(customer_id,vendor_id)
 DO UPDATE SET
   address_type='house',
   manual_address=$3,
   apartment_id=NULL,
   block_id=NULL,
   flat_number=NULL
 `,[c,v,addr])
}

/* STATE */

async function getState(p){
 return (await pool.query("SELECT * FROM conversation_state WHERE phone=$1",[p])).rows[0]
}

async function setState(p,s,v,temp={}){
 await pool.query(`
 INSERT INTO conversation_state(phone,state,selected_vendor_id,temp_data)
 VALUES($1,$2,$3,$4)
 ON CONFLICT(phone)
 DO UPDATE SET state=$2,selected_vendor_id=$3,temp_data=$4
 `,[p,s,v,temp])
}

/* ---------------- MENUS ---------------- */

async function sendMainMenu(pid,phone,sub){

 let rows=[]

 if(!sub){
 rows=[{id:"subscribe",title:"Subscribe Milk"}]
 }else{
 if(sub.status==="active"){
 rows=[
 {id:"view",title:"View Subscription"},
 {id:"change",title:"Change Quantity"},
 {id:"profile",title:"Update Address"},
 {id:"stop",title:"Stop Subscription"}
 ]
 }else{
 rows=[{id:"resume",title:"Resume Subscription"}]
 }
 }

 await sendList(pid,phone,"Milk Service Menu",rows)
}

async function sendQty(pid,phone,prefix){
 await sendList(pid,phone,"Select Quantity",
 addNav([
 {id:`${prefix}_1`,title:"1 Packet"},
 {id:`${prefix}_2`,title:"2 Packets"},
 {id:`${prefix}_3`,title:"3 Packets"},
 {id:`${prefix}_4`,title:"4 Packets"},
 {id:`${prefix}_5`,title:"5 Packets"}
 ])
 )
}

/* ---------------- ADDRESS FLOW ---------------- */

async function startAddress(pid,phone,vendor){
 await sendList(pid,phone,"Select Address Type",
 addNav([
 {id:"apt",title:"Apartment"},
 {id:"house",title:"House"}
 ])
 )
 await setState(phone,"addr_type",vendor.vendor_id)
}

/* ---------------- MAIN ---------------- */

async function handleCustomerBot(msg,pid){

 if(processedMessages.has(msg.id)) return
 processedMessages.add(msg.id)

 const phone=msg.from
 const vendor=await getVendor(pid)
 if(!vendor || !vendor.is_active) return

 const customer=await getCustomer(phone)
 const state=await getState(phone)

 let id=null
 if(msg.type==="text") id=msg.text.body.toLowerCase().trim()
 if(msg.type==="interactive") id=msg.interactive?.list_reply?.id

 /* MENU NAV */

 if(id==="menu"){
 const sub=await getSubscription(customer.customer_id,vendor.vendor_id)
 await setState(phone,"menu",vendor.vendor_id)
 await sendMainMenu(pid,phone,sub)
 return
 }

 /* FIRST */

 if(!state || id==="hi"){
 await sendText(pid,phone,"👋 Welcome to Milk Service")
 const sub=await getSubscription(customer.customer_id,vendor.vendor_id)
 await setState(phone,"menu",vendor.vendor_id)
 await sendMainMenu(pid,phone,sub)
 return
 }

 /* MENU */

 if(state.state==="menu"){

 const sub=await getSubscription(customer.customer_id,vendor.vendor_id)

 if(id==="subscribe"){
 const addr=await getAddress(customer.customer_id,vendor.vendor_id)
 if(!addr){
 await sendText(pid,phone,"Please add address first")
 await startAddress(pid,phone,vendor)
 return
 }
 await sendQty(pid,phone,"sub")
 await setState(phone,"sub_qty",vendor.vendor_id)
 }

 if(id==="profile"){

 const addr = await getAddress(customer.customer_id,vendor.vendor_id)

 if(addr){

 let text="📍 Your Current Address:\n\n"

 if(addr.address_type==="apartment"){
 text += `${addr.apartment_name}, Block ${addr.block_name}, Flat ${addr.flat_number}`
 }else{
 text += addr.manual_address
 }

 await sendText(pid,phone,text)
 }

 await startAddress(pid,phone,vendor)

 return
}

 if(id==="view"){
 await sendText(pid,phone,`Quantity: ${sub.quantity}\nStatus: ${sub.status}`)
 await sendMainMenu(pid,phone,sub)
 }

 if(id==="change"){
 await sendQty(pid,phone,"chg")
 await setState(phone,"chg_qty",vendor.vendor_id)
 }

 if(id==="stop"){
 await pool.query(
 `UPDATE subscriptions SET status='inactive' WHERE customer_id=$1 AND vendor_id=$2`,
 [customer.customer_id,vendor.vendor_id]
 )
 await sendText(pid,phone,"Stopped ❌")
 const s=await getSubscription(customer.customer_id,vendor.vendor_id)
 await sendMainMenu(pid,phone,s)
 }

 if(id==="resume"){
 await pool.query(
 `UPDATE subscriptions SET status='active' WHERE customer_id=$1 AND vendor_id=$2`,
 [customer.customer_id,vendor.vendor_id]
 )
 await sendText(pid,phone,"Resumed ✅")
 const s=await getSubscription(customer.customer_id,vendor.vendor_id)
 await sendMainMenu(pid,phone,s)
 }

 return
 }

 /* QTY */

 if(state.state==="sub_qty" || state.state==="chg_qty"){
 const qty=parseInt(id.split("_")[1])
 await saveSubscription(customer.customer_id,vendor.vendor_id,qty)
 await sendText(pid,phone,"Updated ✅")
 const s=await getSubscription(customer.customer_id,vendor.vendor_id)
 await setState(phone,"menu",vendor.vendor_id)
 await sendMainMenu(pid,phone,s)
 return
 }

 /* ADDRESS FLOW */

 if(state.state==="addr_type"){

 if(id==="apt"){
 const a=await pool.query("SELECT * FROM apartments WHERE vendor_id=$1",[vendor.vendor_id])
 await sendList(pid,phone,"Select Apartment",
 addNav(a.rows.map(x=>({id:`apt_${x.apartment_id}`,title:x.name})))
 )
 await setState(phone,"apt",vendor.vendor_id)
 }

 if(id==="house"){
 await sendText(pid,phone,"Enter your address")
 await setState(phone,"manual",vendor.vendor_id)
 }

 return
 }

 if(state.state==="apt"){
 const aptId=id.split("_")[1]
 const b=await pool.query("SELECT * FROM apartment_blocks WHERE apartment_id=$1",[aptId])
 await sendList(pid,phone,"Select Block",
 addNav(b.rows.map(x=>({id:`block_${x.block_id}`,title:x.block_name})))
 )
 await setState(phone,"block",vendor.vendor_id,{aptId})
 return
 }

 if(state.state==="block"){
 const blockId=id.split("_")[1]
 await sendText(pid,phone,"Enter flat number")
 await setState(phone,"flat",vendor.vendor_id,{...state.temp_data,blockId})
 return
 }

 if(state.state==="flat"){
 const t=state.temp_data
 await saveApartment(customer.customer_id,vendor.vendor_id,t.aptId,t.blockId,id)
 await sendText(pid,phone,"Address updated ✅")
 const s=await getSubscription(customer.customer_id,vendor.vendor_id)
 await setState(phone,"menu",vendor.vendor_id)
 await sendMainMenu(pid,phone,s)
 return
 }

 if(state.state==="manual"){
 await saveManual(customer.customer_id,vendor.vendor_id,id)
 await sendText(pid,phone,"Address updated ✅")
 const s=await getSubscription(customer.customer_id,vendor.vendor_id)
 await setState(phone,"menu",vendor.vendor_id)
 await sendMainMenu(pid,phone,s)
 return
 }

}

module.exports = handleCustomerBot