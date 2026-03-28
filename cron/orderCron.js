const cron = require("node-cron")
const pool = require("../db")
const { generateOrdersForVendor } = require("../services/orderGenerator")

if (process.env.RUN_CRON !== "true") {
  console.log("⏱ Order Cron Disabled (RUN_CRON is not 'true')")
  module.exports = {}
  return
}

console.log("⏱ Order Cron Initialized")

// Runs every minute — fires generation only for vendors whose auto_generate_time matches HH:MM now
cron.schedule("* * * * *", async () => {
  try {
    const now         = new Date()
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`

    const result = await pool.query(`
      SELECT vendor_id
      FROM vendor_settings
      WHERE auto_generate_time IS NOT NULL
        AND TO_CHAR(auto_generate_time, 'HH24:MI') = $1
    `, [currentTime])

    if (result.rowCount === 0) return

    console.log(`⏱ [${currentTime}] Auto-generating orders for ${result.rowCount} vendor(s)...`)

    for (const { vendor_id } of result.rows) {
      try {
        await generateOrdersForVendor(vendor_id)
        console.log(`✅ Orders generated for vendor ${vendor_id}`)
      } catch (err) {
        console.error(`❌ Failed for vendor ${vendor_id}:`, err.message)
      }
    }
  } catch (err) {
    console.error("❌ Cron Error:", err.message)
  }
})
