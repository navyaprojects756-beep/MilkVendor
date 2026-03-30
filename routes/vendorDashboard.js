const express = require("express")
const router  = express.Router()
const pool    = require("../db")
const { verifyVendorToken }    = require("../services/vendorAuth")
const { generateOrdersForVendor } = require("../services/orderGenerator")
const multer  = require("multer")
const path    = require("path")
const fs      = require("fs")

/* ─── NO-CACHE (prevents carrier/proxy 304 on mobile networks) ─── */
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
  res.setHeader("Pragma", "no-cache")
  res.setHeader("Surrogate-Control", "no-store")
  next()
})

/* ─── HELPERS ─── */
function getVendorId(req) {
  try {
    const decoded = verifyVendorToken(req.query.token)
    return decoded.vendorId
  } catch {
    throw new Error("Invalid token")
  }
}

function getDecoded(req) {
  try {
    return verifyVendorToken(req.query.token)
  } catch {
    throw new Error("Invalid token")
  }
}

// Middleware: only tokens with role=admin (or legacy tokens without role) can proceed
function requireAdmin(req, res, next) {
  try {
    const decoded = verifyVendorToken(req.query.token)
    const role = decoded.role || "admin" // legacy tokens default to admin
    if (role !== "admin") return res.status(403).json({ message: "Access denied. Admin link required." })
    next()
  } catch {
    res.status(401).json({ message: "Invalid token" })
  }
}

/* ─── MULTER SETUP ─── */
const uploadDir = path.join(__dirname, "../public/uploads/images/logo")
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"]

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    try {
      const { vendorId } = verifyVendorToken(req.query.token)
      cb(null, `logo_${vendorId}${ext}`)
    } catch {
      cb(null, `logo_${Date.now()}${ext}`)
    }
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Images only"))
    cb(null, true)
  },
})

/* ══════════════════════════════════════════
   LOGO UPLOAD
══════════════════════════════════════════ */

router.post("/upload-logo", requireAdmin, upload.single("logo"), async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    if (!req.file) return res.status(400).json({ message: "No file uploaded" })

    // Delete any old logo files for this vendor with a different extension
    for (const ext of IMAGE_EXTS) {
      const oldFile = path.join(uploadDir, `logo_${vendorId}${ext}`)
      if (oldFile !== req.file.path && fs.existsSync(oldFile)) fs.unlinkSync(oldFile)
    }

    const logo_url = `${req.protocol}://${req.get("host")}/uploads/images/logo/${req.file.filename}`
    res.json({ logo_url })
  } catch (err) {
    console.error(err)
    res.status(401).json({ message: err.message })
  }
})

/* ══════════════════════════════════════════
   ORDERS
══════════════════════════════════════════ */

router.get("/orders", async (req, res) => {
  try {
    const decoded  = getDecoded(req)
    const vendorId = decoded.vendorId
    const role     = decoded.role || "admin"

    const result = await pool.query(`
      SELECT
        o.order_id,
        o.is_delivered,
        o.delivered_at,
        c.phone,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name || ', ' || a.address || ' - ' || b.block_name || ' - ' || cv.flat_number
          ELSE cv.manual_address
        END AS address,
        o.quantity,
        o.order_date,
        a.name   AS apartment,
        b.block_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $1
      LEFT JOIN apartments a ON cv.apartment_id = a.apartment_id
      LEFT JOIN apartment_blocks b ON cv.block_id = b.block_id
      WHERE o.vendor_id = $1
      ORDER BY o.order_date DESC
    `, [vendorId])

    const total = await pool.query(`
      SELECT COALESCE(SUM(quantity), 0) total_packets
      FROM orders
      WHERE vendor_id = $1 AND order_date = CURRENT_DATE + 1
    `, [vendorId])

    const vendor = await pool.query(
      "SELECT vendor_name FROM vendors WHERE vendor_id = $1",
      [vendorId]
    )

    // For delivery role: mask phone numbers based on vendor setting (if column exists)
    let orders = result.rows
    if (role === "delivery") {
      try {
        const settingsRes = await pool.query(
          "SELECT show_phone_numbers FROM vendor_settings WHERE vendor_id = $1",
          [vendorId]
        )
        const showPhone = settingsRes.rows[0]?.show_phone_numbers !== false
        if (!showPhone) {
          orders = orders.map((o) => ({
            ...o,
            phone: `••••••• ${String(o.phone).slice(-3)}`,
          }))
        }
      } catch {
        // show_phone_numbers column not yet in DB — show phones by default
      }
    }

    res.json({
      vendorName:   vendor.rows[0]?.vendor_name || "Vendor",
      totalPackets: total.rows[0].total_packets,
      orders,
    })
  } catch (err) {
    console.error(err)
    res.status(401).send("Invalid token")
  }
})

router.patch("/orders/:id/delivered", async (req, res) => {
  try {
    const vendorId = getVendorId(req)

    const result = await pool.query(
      "SELECT is_delivered FROM orders WHERE order_id = $1 AND vendor_id = $2",
      [req.params.id, vendorId]
    )
    if (result.rowCount === 0) return res.status(404).send("Order not found")

    const newStatus = !result.rows[0].is_delivered

    await pool.query(`
      UPDATE orders
      SET is_delivered = $1,
          delivered_at = CASE WHEN $1 = true THEN NOW() ELSE NULL END
      WHERE order_id = $2 AND vendor_id = $3
    `, [newStatus, req.params.id, vendorId])

    res.json({ message: "Updated", is_delivered: newStatus, delivered_at: newStatus ? new Date() : null })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   APARTMENTS
══════════════════════════════════════════ */

router.get("/apartments", async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const data = await pool.query(
      "SELECT * FROM apartments WHERE vendor_id = $1 ORDER BY apartment_id DESC",
      [vendorId]
    )
    res.json(data.rows)
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.post("/apartments", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { name, address } = req.body
    await pool.query(
      "INSERT INTO apartments(name, address, vendor_id) VALUES($1, $2, $3)",
      [name, address, vendorId]
    )
    res.json({ message: "Apartment added" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.put("/apartments/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { name, address, is_active } = req.body
    await pool.query(`
      UPDATE apartments SET
        name      = COALESCE($1, name),
        address   = COALESCE($2, address),
        is_active = COALESCE($3, is_active)
      WHERE apartment_id = $4 AND vendor_id = $5
    `, [name, address, is_active, req.params.id, vendorId])
    res.json({ message: "Updated" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// PATCH /apartments/:id — inline edit (same as PUT, kept for frontend PATCH calls)
router.patch("/apartments/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { name, address, is_active } = req.body
    await pool.query(`
      UPDATE apartments SET
        name      = COALESCE($1, name),
        address   = COALESCE($2, address),
        is_active = COALESCE($3, is_active)
      WHERE apartment_id = $4 AND vendor_id = $5
    `, [name, address, is_active, req.params.id, vendorId])
    res.json({ message: "Updated" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.patch("/apartments/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    await pool.query(`
      UPDATE apartments SET is_active = NOT is_active
      WHERE apartment_id = $1 AND vendor_id = $2
    `, [req.params.id, vendorId])
    res.json({ message: "Toggled" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.delete("/apartments/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    await pool.query(
      "DELETE FROM apartments WHERE apartment_id = $1 AND vendor_id = $2",
      [req.params.id, vendorId]
    )
    res.json({ message: "Deleted" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   BLOCKS
══════════════════════════════════════════ */

router.get("/blocks/:apartmentId", async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const data = await pool.query(`
      SELECT b.*
      FROM apartment_blocks b
      JOIN apartments a ON b.apartment_id = a.apartment_id
      WHERE b.apartment_id = $1 AND a.vendor_id = $2
      ORDER BY b.block_id DESC
    `, [req.params.apartmentId, vendorId])
    res.json(data.rows)
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.post("/blocks", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { apartment_id, block_name } = req.body

    const check = await pool.query(
      "SELECT 1 FROM apartments WHERE apartment_id = $1 AND vendor_id = $2",
      [apartment_id, vendorId]
    )
    if (check.rowCount === 0) return res.status(403).send("Unauthorized apartment")

    await pool.query(
      "INSERT INTO apartment_blocks(apartment_id, block_name) VALUES($1, $2)",
      [apartment_id, block_name]
    )
    res.json({ message: "Block added" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.put("/blocks/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { block_name, is_active } = req.body
    const r = await pool.query(`
      UPDATE apartment_blocks b SET
        block_name = COALESCE($1, b.block_name),
        is_active  = COALESCE($2, b.is_active)
      FROM apartments a
      WHERE b.block_id = $3 AND b.apartment_id = a.apartment_id AND a.vendor_id = $4
    `, [block_name, is_active, req.params.id, vendorId])
    if (r.rowCount === 0) return res.status(403).send("Unauthorized")
    res.json({ message: "Updated" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// PATCH /blocks/:id — inline edit (same as PUT, kept for frontend PATCH calls)
router.patch("/blocks/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { block_name, is_active } = req.body
    const r = await pool.query(`
      UPDATE apartment_blocks b SET
        block_name = COALESCE($1, b.block_name),
        is_active  = COALESCE($2, b.is_active)
      FROM apartments a
      WHERE b.block_id = $3 AND b.apartment_id = a.apartment_id AND a.vendor_id = $4
    `, [block_name, is_active, req.params.id, vendorId])
    if (r.rowCount === 0) return res.status(403).send("Unauthorized")
    res.json({ message: "Updated" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.patch("/blocks/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const r = await pool.query(`
      UPDATE apartment_blocks b SET is_active = NOT b.is_active
      FROM apartments a
      WHERE b.block_id = $1 AND b.apartment_id = a.apartment_id AND a.vendor_id = $2
    `, [req.params.id, vendorId])
    if (r.rowCount === 0) return res.status(403).send("Unauthorized")
    res.json({ message: "Toggled" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.delete("/blocks/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const r = await pool.query(`
      DELETE FROM apartment_blocks b
      USING apartments a
      WHERE b.block_id = $1 AND b.apartment_id = a.apartment_id AND a.vendor_id = $2
    `, [req.params.id, vendorId])
    if (r.rowCount === 0) return res.status(403).send("Unauthorized")
    res.json({ message: "Deleted" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   VENDOR PROFILE
══════════════════════════════════════════ */

router.get("/profile", async (req, res) => {
  try {
    const vendorId = getVendorId(req)

    await pool.query(`
      INSERT INTO vendor_profile(vendor_id) VALUES($1)
      ON CONFLICT (vendor_id) DO NOTHING
    `, [vendorId])

    const profile = await pool.query(
      "SELECT * FROM vendor_profile WHERE vendor_id = $1",
      [vendorId]
    )
    const vendor = await pool.query(
      "SELECT vendor_name, phone, whatsapp_api_number FROM vendors WHERE vendor_id = $1",
      [vendorId]
    )

    res.json({
      ...profile.rows[0],
      vendor_name: vendor.rows[0]?.vendor_name,
      phone: vendor.rows[0]?.phone,
      whatsapp_api_number: vendor.rows[0]?.whatsapp_api_number,
    })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.put("/profile", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const {
      business_name, description, logo_url,
      delivery_start, delivery_end,
      order_accept_start, order_accept_end,
      active_days,
      whatsapp_number, area, city,
    } = req.body

    await pool.query(`
      INSERT INTO vendor_profile (
        vendor_id, business_name, description, logo_url,
        delivery_start, delivery_end,
        order_accept_start, order_accept_end,
        active_days, whatsapp_number, area, city, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
      ON CONFLICT (vendor_id) DO UPDATE SET
        business_name      = EXCLUDED.business_name,
        description        = EXCLUDED.description,
        logo_url           = EXCLUDED.logo_url,
        delivery_start     = EXCLUDED.delivery_start,
        delivery_end       = EXCLUDED.delivery_end,
        order_accept_start = EXCLUDED.order_accept_start,
        order_accept_end   = EXCLUDED.order_accept_end,
        active_days        = EXCLUDED.active_days,
        whatsapp_number    = EXCLUDED.whatsapp_number,
        area               = EXCLUDED.area,
        city               = EXCLUDED.city,
        updated_at         = NOW()
    `, [
      vendorId, business_name, description, logo_url,
      delivery_start || null, delivery_end || null,
      order_accept_start || null, order_accept_end || null,
      active_days || [0,1,2,3,4,5,6],
      whatsapp_number, area, city,
    ])

    res.json({ message: "Profile saved" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   SETTINGS  (feature toggles)
══════════════════════════════════════════ */

router.get("/settings", async (req, res) => {
  try {
    const vendorId = getVendorId(req)

    await pool.query(`
      INSERT INTO vendor_settings(vendor_id) VALUES($1)
      ON CONFLICT (vendor_id) DO NOTHING
    `, [vendorId])

    const s = await pool.query(
      "SELECT * FROM vendor_settings WHERE vendor_id = $1",
      [vendorId]
    )
    res.json(s.rows[0] || {})
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

router.post("/settings", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const {
      allow_apartments,
      allow_houses,
      allow_blocks,
      require_flat_number,
      allow_manual_address,
      order_window_enabled,
      auto_generate_orders,
      notify_on_delivery,
      notify_pending_eod,
      max_quantity_per_order,
      is_active,
      auto_generate_time,
      price_per_unit,
      show_phone_numbers,
    } = req.body

    await pool.query(`
      INSERT INTO vendor_settings (vendor_id,
        allow_apartments, allow_houses, allow_blocks,
        require_flat_number, allow_manual_address,
        order_window_enabled, auto_generate_orders,
        notify_on_delivery, notify_pending_eod,
        max_quantity_per_order, is_active,
        auto_generate_time, price_per_unit, show_phone_numbers, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
      ON CONFLICT (vendor_id) DO UPDATE SET
        allow_apartments       = COALESCE($2,  vendor_settings.allow_apartments),
        allow_houses           = COALESCE($3,  vendor_settings.allow_houses),
        allow_blocks           = COALESCE($4,  vendor_settings.allow_blocks),
        require_flat_number    = COALESCE($5,  vendor_settings.require_flat_number),
        allow_manual_address   = COALESCE($6,  vendor_settings.allow_manual_address),
        order_window_enabled   = COALESCE($7,  vendor_settings.order_window_enabled),
        auto_generate_orders   = COALESCE($8,  vendor_settings.auto_generate_orders),
        notify_on_delivery     = COALESCE($9,  vendor_settings.notify_on_delivery),
        notify_pending_eod     = COALESCE($10, vendor_settings.notify_pending_eod),
        max_quantity_per_order = COALESCE($11, vendor_settings.max_quantity_per_order),
        is_active              = COALESCE($12, vendor_settings.is_active),
        auto_generate_time     = COALESCE($13, vendor_settings.auto_generate_time),
        price_per_unit         = COALESCE($14, vendor_settings.price_per_unit),
        show_phone_numbers     = COALESCE($15, vendor_settings.show_phone_numbers),
        updated_at             = NOW()
    `, [
      vendorId,
      allow_apartments, allow_houses, allow_blocks,
      require_flat_number, allow_manual_address,
      order_window_enabled, auto_generate_orders,
      notify_on_delivery, notify_pending_eod,
      max_quantity_per_order, is_active,
      auto_generate_time || null,
      price_per_unit != null ? parseFloat(price_per_unit) : null,
      show_phone_numbers != null ? Boolean(show_phone_numbers) : null,
    ])

    res.json({ message: "Settings saved" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   PUBLIC ORDER-WINDOW CHECK
══════════════════════════════════════════ */
router.get("/order-window/:vendorId", async (req, res) => {
  try {
    const { vendorId } = req.params

    const profile  = await pool.query(
      "SELECT order_accept_start, order_accept_end, active_days FROM vendor_profile WHERE vendor_id = $1",
      [vendorId]
    )
    const settings = await pool.query(
      "SELECT order_window_enabled, allow_apartments, allow_houses, allow_blocks, allow_manual_address, max_quantity_per_order FROM vendor_settings WHERE vendor_id = $1",
      [vendorId]
    )

    const p = profile.rows[0]  || {}
    const s = settings.rows[0] || {}

    let is_open = true
    if (s.order_window_enabled && p.order_accept_start && p.order_accept_end) {
      const now   = new Date()
      const hhmm  = now.getHours() * 60 + now.getMinutes()
      const [sh, sm] = p.order_accept_start.split(":").map(Number)
      const [eh, em] = p.order_accept_end.split(":").map(Number)
      const start = sh * 60 + sm
      const end   = eh * 60 + em
      is_open     = hhmm >= start && hhmm <= end

      const todayDay = now.getDay()
      if (p.active_days && !p.active_days.includes(todayDay)) {
        is_open = false
      }
    }

    res.json({
      is_open,
      order_accept_start:   p.order_accept_start,
      order_accept_end:     p.order_accept_end,
      allow_apartments:     s.allow_apartments,
      allow_houses:         s.allow_houses,
      allow_blocks:         s.allow_blocks,
      allow_manual_address: s.allow_manual_address,
      max_quantity:         s.max_quantity_per_order,
    })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   GENERATE TODAY'S ORDERS (manual trigger)
══════════════════════════════════════════ */

router.post("/generate-orders", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    await generateOrdersForVendor(vendorId)
    res.json({ message: "Orders generated" })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   CUSTOMERS
══════════════════════════════════════════ */

router.get("/customers", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const data = await pool.query(`
      SELECT
        c.customer_id,
        c.phone,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.name        AS apartment_name,
        a.apartment_id,
        b.block_name,
        s.quantity    AS subscription_quantity,
        s.status      AS subscription_status,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name
            || COALESCE(' - ' || b.block_name, '')
            || COALESCE(' - Flat ' || cv.flat_number, '')
          ELSE COALESCE(cv.manual_address, '')
        END AS address
      FROM customers c
      JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $1
      LEFT JOIN apartments a ON cv.apartment_id = a.apartment_id
      LEFT JOIN apartment_blocks b ON cv.block_id = b.block_id
      LEFT JOIN subscriptions s
        ON s.customer_id = c.customer_id AND s.vendor_id = $1
      ORDER BY a.name NULLS LAST, c.customer_id
    `, [vendorId])
    res.json(data.rows)
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ── PDF download (binary) — used by dashboard download & WhatsApp bot ── */
router.get("/customers/:id/invoice/pdf", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { from, to } = req.query
    if (!from || !to) return res.status(400).json({ error: "from and to are required" })

    const [custR, ordersR, settingsR, profileR] = await Promise.all([
      pool.query(`
        SELECT c.customer_id, c.phone,
          CASE WHEN cv.address_type='apartment'
          THEN a.name || COALESCE(' - '||b.block_name,'') || COALESCE(' - Flat '||cv.flat_number,'')
          ELSE COALESCE(cv.manual_address,'') END AS address
        FROM customers c
        JOIN customer_vendor_profile cv ON cv.customer_id=c.customer_id AND cv.vendor_id=$2
        LEFT JOIN apartments a ON cv.apartment_id=a.apartment_id
        LEFT JOIN apartment_blocks b ON cv.block_id=b.block_id
        WHERE c.customer_id=$1
      `, [req.params.id, vendorId]),
      pool.query(
        `SELECT order_date, quantity, is_delivered FROM orders
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4
         ORDER BY order_date`,
        [req.params.id, vendorId, from, to]
      ),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vendorId]),
      pool.query("SELECT business_name, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id=$1", [vendorId]),
    ])

    if (custR.rowCount === 0) return res.status(404).json({ error: "Customer not found" })

    const { generateInvoicePDF } = require("../services/invoicePDF")
    const pdfBuffer = await generateInvoicePDF(
      {
        customer:       custR.rows[0],
        orders:         ordersR.rows,
        price_per_unit: parseFloat(settingsR.rows[0]?.price_per_unit || 0),
        vendor:         profileR.rows[0] || {},
      },
      from, to
    )

    const filename = `bill_${custR.rows[0].phone}_${from}_${to}.pdf`
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.send(pdfBuffer)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

/* ── JSON data (used by dialog preview) ── */
router.get("/customers/:id/invoice", requireAdmin, async (req, res) => {
  try {
    const vendorId  = getVendorId(req)
    const { from, to } = req.query

    const customer = await pool.query(`
      SELECT
        c.customer_id, c.phone,
        cv.address_type, cv.flat_number, cv.manual_address,
        a.name AS apartment_name, b.block_name,
        s.quantity AS subscription_quantity,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name
            || COALESCE(' - ' || b.block_name, '')
            || COALESCE(' - Flat ' || cv.flat_number, '')
          ELSE COALESCE(cv.manual_address, '')
        END AS address
      FROM customers c
      JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $2
      LEFT JOIN apartments a ON cv.apartment_id = a.apartment_id
      LEFT JOIN apartment_blocks b ON cv.block_id = b.block_id
      LEFT JOIN subscriptions s
        ON s.customer_id = c.customer_id AND s.vendor_id = $2
      WHERE c.customer_id = $1
    `, [req.params.id, vendorId])

    if (customer.rowCount === 0) return res.status(404).send("Customer not found")

    const orders = await pool.query(`
      SELECT order_date, quantity, is_delivered, delivered_at
      FROM orders
      WHERE customer_id = $1 AND vendor_id = $2
        AND order_date >= $3 AND order_date <= $4
      ORDER BY order_date
    `, [req.params.id, vendorId, from, to])

    const settings = await pool.query(
      "SELECT price_per_unit FROM vendor_settings WHERE vendor_id = $1",
      [vendorId]
    )
    const profile = await pool.query(
      "SELECT business_name, logo_url, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id = $1",
      [vendorId]
    )

    res.json({
      customer:       customer.rows[0],
      orders:         orders.rows,
      price_per_unit: parseFloat(settings.rows[0]?.price_per_unit || 0),
      vendor:         profile.rows[0] || {},
    })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ─── PAUSES ─── */

// GET /pauses — all active/upcoming pauses for this vendor
router.get("/pauses", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const r = await pool.query(`
      SELECT
        sp.pause_id,
        sp.customer_id,
        sp.pause_from,
        sp.pause_until,
        sp.created_at,
        c.phone,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.name       AS apartment_name,
        b.block_name
      FROM subscription_pauses sp
      JOIN customers c ON c.customer_id = sp.customer_id
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = sp.customer_id AND cv.vendor_id = sp.vendor_id
      LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
      LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
      WHERE sp.vendor_id = $1
        AND (sp.pause_until IS NULL OR sp.pause_until >= CURRENT_DATE)
      ORDER BY sp.pause_from ASC
    `, [vendorId])
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /pauses/:pauseId — vendor resumes a customer early
router.delete("/pauses/:pauseId", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const result = await pool.query(
      "DELETE FROM subscription_pauses WHERE pause_id=$1 AND vendor_id=$2 RETURNING pause_id",
      [req.params.pauseId, vendorId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: "Pause not found" })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
