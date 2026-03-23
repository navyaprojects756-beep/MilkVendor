const cron = require("node-cron")
const pool = require("../db")

console.log("⏱ Order Cron Initialized")

// Every 5 seconds
cron.schedule("*/50 * * * * *", async () => {

 try{

 console.log("🔄 Running order cron...")

 /* Insert orders for tomorrow based on subscriptions */
 await pool.query(`
 INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
 SELECT 
   s.customer_id,
   s.vendor_id,
   CURRENT_DATE + 1,
   s.quantity
 FROM subscriptions s
 WHERE s.status='active'
 AND NOT EXISTS (
   SELECT 1 FROM orders o
   WHERE o.customer_id = s.customer_id
   AND o.vendor_id = s.vendor_id
   AND o.order_date = CURRENT_DATE + 1
 )
 `)

 console.log("✅ Orders generated successfully")

 }
 catch(err){

 console.log("❌ Cron Error:", err.message)

 }

})