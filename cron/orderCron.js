const cron = require("node-cron")
const pool = require("../db")

console.log("⏱ Order Cron Initialized")

// Every 5 seconds
cron.schedule("*/5 * * * * *", async () => {

 try{

 console.log("🔄 Running order cron...")

 await pool.query(`
 INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
 SELECT 
   s.customer_id,
   s.vendor_id,
   CURRENT_DATE + 1,
   s.quantity
 FROM subscriptions s
 WHERE s.status='active'

 ON CONFLICT (customer_id, vendor_id, order_date)
 DO UPDATE SET quantity = EXCLUDED.quantity
 `)

 await pool.query(`
DELETE FROM orders o
WHERE NOT EXISTS (
 SELECT 1 FROM subscriptions s
 WHERE s.customer_id=o.customer_id
 AND s.vendor_id=o.vendor_id
 AND s.status='active'
)
AND o.order_date = CURRENT_DATE + 1
`)

 console.log("✅ Orders upserted successfully")

 }
 catch(err){

 console.log("❌ Cron Error:", err.message)

 }

})