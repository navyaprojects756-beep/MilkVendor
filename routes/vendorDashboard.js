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

 /* ORDERS WITH FULL ADDRESS */
 const result = await pool.query(`
 SELECT
 c.phone,

 CASE 
  WHEN cv.address_type='apartment'
  THEN a.name || ', ' || a.address || ' - ' || b.block_name || ' - ' || cv.flat_number
  ELSE cv.manual_address
 END as address,

 o.quantity,
 o.order_date,
 a.name as apartment

 FROM orders o
 JOIN customers c ON o.customer_id=c.customer_id

 LEFT JOIN customer_vendor_profile cv
  ON cv.customer_id=c.customer_id AND cv.vendor_id=$1

 LEFT JOIN apartments a
  ON cv.apartment_id=a.apartment_id

 LEFT JOIN apartment_blocks b
  ON cv.block_id=b.block_id

 WHERE o.vendor_id=$1
 ORDER BY o.order_date DESC
 `,[vendorId])

 /* TOTAL */
 const total = await pool.query(`
 SELECT SUM(quantity) total_packets
 FROM orders
 WHERE vendor_id=$1
 AND order_date=CURRENT_DATE + 1
 `,[vendorId])

 /* VENDOR NAME */
 const vendor = await pool.query(
 "SELECT vendor_name FROM vendors WHERE vendor_id=$1",
 [vendorId]
 )

 res.json({
  vendorName: vendor.rows[0]?.vendor_name || "Vendor",
  totalPackets: total.rows[0].total_packets || 0,
  orders: result.rows
 })

 }
 catch(err){
 console.log(err)
 res.status(401).send("Invalid token")
 }

})

/* ---------------- GENERATE ---------------- */

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