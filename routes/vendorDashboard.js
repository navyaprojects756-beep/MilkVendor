const express = require("express")
const router = express.Router()

const pool = require("../db")
const { verifyVendorToken } = require("../services/vendorAuth")

/* ---------------- HELPER ---------------- */

function getVendorId(req){
 try{
  const token = req.query.token
  const decoded = verifyVendorToken(token)
  return decoded.vendorId
 }catch(err){
  throw new Error("Invalid token")
 }
}

/* ---------------- ORDERS ---------------- */

router.get("/orders", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  const result = await pool.query(`
   SELECT
   c.phone,

   CASE 
    WHEN cv.address_type='apartment'
    THEN a.name || ', ' || a.address || ' - ' || b.block_name || ' - ' || cv.flat_number
    ELSE cv.manual_address
   END as address,

   o.quantity,
   o.order_date

   FROM orders o
   JOIN customers c ON o.customer_id=c.customer_id

   LEFT JOIN customer_vendor_profile cv
    ON cv.customer_id=c.customer_id AND cv.vendor_id=$1

   LEFT JOIN apartments a ON cv.apartment_id=a.apartment_id
   LEFT JOIN apartment_blocks b ON cv.block_id=b.block_id

   WHERE o.vendor_id=$1
   ORDER BY o.order_date DESC
  `,[vendorId])

  const total = await pool.query(`
   SELECT COALESCE(SUM(quantity),0) total_packets
   FROM orders
   WHERE vendor_id=$1
   AND order_date = CURRENT_DATE + 1
  `,[vendorId])

  const vendor = await pool.query(
   "SELECT vendor_name FROM vendors WHERE vendor_id=$1",
   [vendorId]
  )

  res.json({
   vendorName: vendor.rows[0]?.vendor_name || "Vendor",
   totalPackets: total.rows[0].total_packets,
   orders: result.rows
  })

 }catch(err){
  console.log(err)
  res.status(401).send("Invalid token")
 }
})

/* ---------------- APARTMENTS ---------------- */

router.get("/apartments", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  const data = await pool.query(
   "SELECT * FROM apartments WHERE vendor_id=$1 ORDER BY apartment_id DESC",
   [vendorId]
  )

  res.json(data.rows)

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

router.post("/apartments", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)
  const {name,address} = req.body

  await pool.query(
   `INSERT INTO apartments(name,address,vendor_id)
    VALUES($1,$2,$3)`,
   [name,address,vendorId]
  )

  res.json({message:"Apartment added"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ✅ FIXED UPDATE (NO NULL OVERWRITE) */
router.put("/apartments/:id", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)
  const {name,address,is_active} = req.body

  await pool.query(`
   UPDATE apartments SET
   name = COALESCE($1,name),
   address = COALESCE($2,address),
   is_active = COALESCE($3,is_active)
   WHERE apartment_id=$4 AND vendor_id=$5
  `,
  [name,address,is_active,req.params.id,vendorId])

  res.json({message:"Updated"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ✅ TOGGLE (BEST PRACTICE) */
router.patch("/apartments/:id/toggle", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  await pool.query(`
   UPDATE apartments
   SET is_active = NOT is_active
   WHERE apartment_id=$1 AND vendor_id=$2
  `,
  [req.params.id,vendorId])

  res.json({message:"Toggled"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

router.delete("/apartments/:id", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  await pool.query(
   "DELETE FROM apartments WHERE apartment_id=$1 AND vendor_id=$2",
   [req.params.id,vendorId]
  )

  res.json({message:"Deleted"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ---------------- BLOCKS ---------------- */

router.get("/blocks/:apartmentId", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  const data = await pool.query(`
   SELECT b.*
   FROM apartment_blocks b
   JOIN apartments a ON b.apartment_id=a.apartment_id
   WHERE b.apartment_id=$1 AND a.vendor_id=$2
   ORDER BY b.block_id DESC
  `,
  [req.params.apartmentId,vendorId])

  res.json(data.rows)

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

router.post("/blocks", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)
  const {apartment_id,block_name} = req.body

  // ensure apartment belongs to vendor
  const check = await pool.query(
   "SELECT 1 FROM apartments WHERE apartment_id=$1 AND vendor_id=$2",
   [apartment_id,vendorId]
  )

  if(check.rowCount === 0){
   return res.status(403).send("Unauthorized apartment")
  }

  await pool.query(
   `INSERT INTO apartment_blocks(apartment_id,block_name)
    VALUES($1,$2)`,
   [apartment_id,block_name]
  )

  res.json({message:"Block added"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ✅ FIXED UPDATE */
router.put("/blocks/:id", async (req,res)=>{
 try{
  const {block_name,is_active} = req.body

  await pool.query(`
   UPDATE apartment_blocks SET
   block_name = COALESCE($1,block_name),
   is_active = COALESCE($2,is_active)
   WHERE block_id=$3
  `,
  [block_name,is_active,req.params.id])

  res.json({message:"Updated"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ✅ TOGGLE */
router.patch("/blocks/:id/toggle", async (req,res)=>{
 try{
  await pool.query(`
   UPDATE apartment_blocks
   SET is_active = NOT is_active
   WHERE block_id=$1
  `,
  [req.params.id])

  res.json({message:"Toggled"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

router.delete("/blocks/:id", async (req,res)=>{
 try{
  await pool.query(
   "DELETE FROM apartment_blocks WHERE block_id=$1",
   [req.params.id]
  )

  res.json({message:"Deleted"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

/* ---------------- SETTINGS ---------------- */

router.get("/settings", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)

  const s = await pool.query(
   "SELECT * FROM vendor_settings WHERE vendor_id=$1",
   [vendorId]
  )

  res.json(s.rows[0] || {})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

router.post("/settings", async (req,res)=>{
 try{
  const vendorId = getVendorId(req)
  const {allow_apartments,allow_houses,is_active} = req.body

  await pool.query(`
   INSERT INTO vendor_settings(vendor_id,allow_apartments,allow_houses,is_active)
   VALUES($1,$2,$3,$4)
   ON CONFLICT (vendor_id)
   DO UPDATE SET
   allow_apartments=$2,
   allow_houses=$3,
   is_active=$4
  `,
  [vendorId,allow_apartments,allow_houses,is_active])

  res.json({message:"Saved"})

 }catch(err){
  console.log(err)
  res.status(500).send("Error")
 }
})

module.exports = router