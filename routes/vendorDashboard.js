const express = require("express")
const router = express.Router()

const pool = require("../db")
const { verifyVendorToken } = require("../services/vendorAuth")

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
 s.quantity
 FROM subscriptions s
 JOIN customers c
 ON s.customer_id=c.customer_id
 LEFT JOIN customer_vendor_profile cv
 ON cv.customer_id=c.customer_id
 AND cv.vendor_id=$1
 WHERE s.vendor_id=$1
 AND s.status='active'
 `,
 [vendorId]
 )

 const total = await pool.query(
 `
 SELECT SUM(quantity) total_packets
 FROM subscriptions
 WHERE vendor_id=$1
 AND status='active'
 `,
 [vendorId]
 )

 res.json({
  totalPackets: total.rows[0].total_packets || 0,
  orders: result.rows
 })

 }
 catch(err){

 res.status(401).send("Invalid token")

 }

})

module.exports = router