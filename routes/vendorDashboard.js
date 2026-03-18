const express = require("express")
const router = express.Router()

const pool = require("../db")
const { verifyVendorToken } = require("../services/vendorAuth")

/* ---------------- GET ORDERS ---------------- */

router.get("/orders", async (req,res)=>{

 try{

 const token=req.query.token
 const decoded = verifyVendorToken(token)
 const vendorId = decoded.vendorId

 const result = await pool.query(
 `
 SELECT
 c.phone,
 cv.address,
 o.quantity,
 o.order_date
 FROM orders o
 JOIN customers c
 ON o.customer_id=c.customer_id
 LEFT JOIN customer_vendor_profile cv
 ON cv.customer_id=c.customer_id
 AND cv.vendor_id=$1
 WHERE o.vendor_id=$1
 ORDER BY o.order_date DESC
 `,
 [vendorId]
 )

 const total = await pool.query(
 `
 SELECT SUM(quantity) total_packets
 FROM orders
 WHERE vendor_id=$1
 AND order_date=CURRENT_DATE + 1
 `,
 [vendorId]
 )

 res.json({
  totalPackets: total.rows[0].total_packets || 0,
  orders: result.rows
 })

 }
 catch(err){

 console.log(err)
 res.status(401).send("Invalid token")

 }

})

/* ---------------- MANUAL GENERATE ORDERS ---------------- */

router.post("/generate-orders", async (req,res)=>{

 try{

 const token=req.query.token
 const decoded = verifyVendorToken(token)
 const vendorId = decoded.vendorId

 await pool.query(`
 INSERT INTO orders (customer_id, vendor_id, order_date, quantity)
 SELECT 
   s.customer_id,
   s.vendor_id,
   CURRENT_DATE + 1,
   s.quantity
 FROM subscriptions s
 WHERE s.vendor_id=$1
 AND s.status='active'
 AND NOT EXISTS (
   SELECT 1 FROM orders o
   WHERE o.customer_id = s.customer_id
   AND o.vendor_id = s.vendor_id
   AND o.order_date = CURRENT_DATE + 1
 )
 `,[vendorId])

 res.json({message:"Orders generated successfully"})

 }
 catch(err){

 console.log(err)
 res.status(401).send("Error generating orders")

 }

})

module.exports = router