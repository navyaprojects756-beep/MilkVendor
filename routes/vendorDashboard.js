const express = require("express")
const axios   = require("axios")
const router  = express.Router()
const pool    = require("../db")
const { verifyVendorToken }    = require("../services/vendorAuth")
const { generateOrdersForVendor } = require("../services/orderGenerator")
const multer  = require("multer")
const path    = require("path")
const fs      = require("fs")
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

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

function getISTDateStr(offsetDays = 0) {
  const now = new Date()
  const istNow = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
  const date = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function timeToMinutes(value) {
  if (!value) return null
  const [h, m] = String(value).split(":").map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return (h * 60) + m
}

function addMinutesToTime(value, addMins) {
  const mins = timeToMinutes(value)
  if (mins == null) return null
  const total = (mins + addMins + 1440) % 1440
  const hh = String(Math.floor(total / 60)).padStart(2, "0")
  const mm = String(total % 60).padStart(2, "0")
  return `${hh}:${mm}`
}

function isOvernightWindow(startMins, endMins) {
  return startMins != null && endMins != null && startMins > endMins
}

function isWithinTimeWindow(nowMins, startMins, endMins) {
  if (startMins == null || endMins == null) return true
  if (startMins === endMins) return false
  if (startMins < endMins) return nowMins >= startMins && nowMins <= endMins
  return nowMins >= startMins || nowMins <= endMins
}

function overlapsNextDayDelivery(deliveryStart, deliveryEnd, acceptStart, acceptEnd) {
  if (deliveryStart == null || deliveryEnd == null || acceptStart == null || acceptEnd == null) return false
  if (acceptStart <= acceptEnd) return false
  const acceptanceRange = { start: acceptStart, end: acceptEnd + 1440 }
  const deliveryRange = { start: deliveryStart + 1440, end: deliveryEnd + 1440 }
  return acceptanceRange.start < deliveryRange.end && deliveryRange.start < acceptanceRange.end
}

function getWindowActiveDay(now, startMins, endMins) {
  const currentDay = now.getDay()
  if (isOvernightWindow(startMins, endMins)) {
    const nowMins = now.getHours() * 60 + now.getMinutes()
    if (nowMins <= endMins) return (currentDay + 6) % 7
  }
  return currentDay
}

function validateSchedule(profile = {}, settings = {}) {
  const deliveryStart = timeToMinutes(profile.delivery_start)
  const deliveryEnd = timeToMinutes(profile.delivery_end)
  const acceptStart = timeToMinutes(profile.order_accept_start)
  const acceptEnd = timeToMinutes(profile.order_accept_end)
  const autoGenerate = timeToMinutes(settings.auto_generate_time)

  if ((profile.delivery_start && !profile.delivery_end) || (!profile.delivery_start && profile.delivery_end)) {
    return "Please set both delivery start and delivery end times."
  }
  if ((profile.order_accept_start && !profile.order_accept_end) || (!profile.order_accept_start && profile.order_accept_end)) {
    return "Please set both order acceptance start and end times."
  }
  if (deliveryStart != null && deliveryEnd != null && deliveryStart >= deliveryEnd) {
    return "Delivery end time must be after delivery start time."
  }
  if (acceptStart != null && acceptEnd != null && acceptStart === acceptEnd) {
    return "Order acceptance start and end time cannot be the same."
  }
  if (deliveryEnd != null && acceptStart != null && acceptStart < acceptEnd && acceptStart <= deliveryEnd) {
    return "Order acceptance must start after delivery end time."
  }
  if (overlapsNextDayDelivery(deliveryStart, deliveryEnd, acceptStart, acceptEnd)) {
    return "Order acceptance window cannot continue into delivery time. Adjust the end time or delivery time."
  }
  if (settings.auto_generate_time && deliveryEnd != null && autoGenerate != null && autoGenerate < deliveryEnd) {
    return "Daily generation time cannot be earlier than delivery end time."
  }
  return null
}

function normalizeText(value) {
  return String(value || "").trim()
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "").trim()
}

async function sendVendorWhatsAppText(phoneNumberId, phone, text) {
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text, preview_url: false },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  )
  return response.data
}

router.post("/register-interest", async (req, res) => {
  try {
    const fullName = normalizeText(req.body?.full_name)
    const shopName = normalizeText(req.body?.shop_name)
    const shopAddress = normalizeText(req.body?.shop_address)
    const contactNumber = normalizePhone(req.body?.contact_number)
    const whatsappApiNumber = normalizePhone(req.body?.whatsapp_api_number)
    const acceptedTerms = req.body?.accepted_terms === true

    if (!fullName || !shopName || !shopAddress || !contactNumber || !whatsappApiNumber) {
      return res.status(400).json({ message: "Please fill all required vendor details." })
    }
    if (!acceptedTerms) {
      return res.status(400).json({ message: "Please approve the terms and conditions." })
    }

    const inserted = await pool.query(`
      INSERT INTO vendors (
        contact_name,
        vendor_name,
        address,
        phone,
        phone_number_id,
        is_active,
        whatsapp_api_number
      ) VALUES ($1, $2, $3, $4, '', false, $5)
      RETURNING vendor_id, contact_name, vendor_name, address, phone, phone_number_id, is_active, whatsapp_api_number
    `, [fullName, shopName, shopAddress, contactNumber, whatsappApiNumber])

    res.status(201).json({
      message: "Thank you. Our vendor team will contact you soon.",
      vendor: inserted.rows[0],
    })
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ message: "This WhatsApp API number is already registered." })
    }
    console.error("Vendor public registration error:", err.message)
    res.status(500).json({ message: "Could not save vendor details right now." })
  }
})

function getTemplateLanguageCandidates(languageCode) {
  const normalized = String(languageCode || "").trim()
  const codes = [normalized, "en", "en_US"].filter(Boolean)
  return [...new Set(codes)]
}

async function sendVendorWhatsAppTemplate(phoneNumberId, phone, templateName, bodyParameters = [], languageCode = "en") {
  let lastError = null
  for (const code of getTemplateLanguageCandidates(languageCode)) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: phone,
          type: "template",
          template: {
            name: templateName,
            language: { code },
            components: [
              {
                type: "body",
                parameters: bodyParameters.map((text) => ({
                  type: "text",
                  text: String(text ?? ""),
                })),
              },
            ],
          },
        },
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      )
      return response.data
    } catch (err) {
      lastError = err
      const details = err.response?.data?.error?.details || err.response?.data?.error?.message || ""
      const shouldRetryWithFallback = /language|locale|translation|parameter value is not valid/i.test(details)
      if (!shouldRetryWithFallback) throw err
    }
  }
  throw lastError
}

function normalizeDateOnly(value) {
  if (!value) return null
  return String(value).slice(0, 10)
}

function formatISTDate(value) {
  if (!value) return ""
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)
}

function formatAmount(value) {
  const num = Number.parseFloat(value || 0) || 0
  return num.toFixed(2).replace(/\.00$/, "")
}

async function getNoticeTemplateByKey(templateKey) {
  const result = await pool.query(
    `SELECT *
     FROM whatsapp_notice_templates
     WHERE template_key = $1 AND is_active = true
     LIMIT 1`,
    [templateKey]
  )
  return result.rows[0] || null
}

async function getNoticeReasonByCode(reasonCode) {
  if (!reasonCode) return null
  const result = await pool.query(
    `SELECT *
     FROM whatsapp_notice_reasons
     WHERE reason_code = $1 AND is_active = true
     LIMIT 1`,
    [reasonCode]
  )
  return result.rows[0] || null
}

async function getNoticeAudience(vendorId, { from, to }) {
  const query = `
    WITH delivered_order_totals AS (
      SELECT
        o.customer_id,
        o.payment_status,
        COALESCE(SUM(oi.quantity * oi.price_at_order), 0)
        + CASE
            WHEN COALESCE(MAX(o.delivery_charge_amount), 0) > 0 THEN COALESCE(MAX(o.delivery_charge_amount), 0)
            ELSE COALESCE(SUM(oi.delivery_charge_at_order), 0)
          END AS order_total
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.vendor_id = $1
        AND o.is_delivered = true
        AND o.order_date >= $2::date
        AND o.order_date <= $3::date
      GROUP BY o.order_id, o.customer_id, o.payment_status
    ),
    order_totals AS (
      SELECT
        customer_id,
        COALESCE(SUM(order_total), 0) AS total_billed
      FROM delivered_order_totals
      GROUP BY customer_id
    ),
    payment_totals AS (
      SELECT
        p.customer_id,
        SUM(CASE WHEN p.is_verified = true AND COALESCE(p.is_revoked, false) = false THEN p.amount ELSE 0 END) AS received_amount
      FROM payments p
      WHERE p.vendor_id = $1
        AND p.payment_date >= $2::date
        AND p.payment_date <= $3::date
      GROUP BY p.customer_id
    )
    SELECT
      c.customer_id,
      c.name AS customer_name,
      c.phone AS customer_phone,
      cv.address_type,
      cv.flat_number,
      cv.manual_address,
      a.apartment_id,
      a.name AS apartment_name,
      b.block_id,
      b.block_name,
      CASE
        WHEN cv.address_type = 'apartment'
        THEN a.name || COALESCE(' - ' || b.block_name, '') || COALESCE(' - Flat ' || cv.flat_number, '')
        ELSE COALESCE(cv.manual_address, '')
      END AS address,
      COALESCE(ot.total_billed, 0) AS total_billed,
      COALESCE(pt.received_amount, 0) AS received_amount,
      GREATEST(COALESCE(ot.total_billed, 0) - COALESCE(pt.received_amount, 0), 0) AS outstanding
    FROM customer_vendor_profile cv
    JOIN customers c ON c.customer_id = cv.customer_id
    LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
    LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
    LEFT JOIN order_totals ot ON ot.customer_id = cv.customer_id
    LEFT JOIN payment_totals pt ON pt.customer_id = cv.customer_id
    WHERE cv.vendor_id = $1
  `
  const result = await pool.query(query, [vendorId, from, to])
  return result.rows
}

function applyNoticeFilters(rows, { search = "", locationId = "", blockId = "", onlyNotPaid = false }) {
  const q = String(search || "").trim().toLowerCase()
  return rows.filter((row) => {
    if (onlyNotPaid && !(Number.parseFloat(row.outstanding || 0) > 0)) return false
    if (locationId === "__individual__" && row.address_type === "apartment") return false
    if (locationId && locationId !== "__individual__" && String(row.apartment_id || "") !== String(locationId)) return false
    if (blockId && String(row.block_id || "") !== String(blockId)) return false
    if (!q) return true
    return [
      row.customer_name,
      row.customer_phone,
      row.address,
      row.apartment_name,
      row.block_name,
    ].some((value) => String(value || "").toLowerCase().includes(q))
  })
}

async function restorePausedOrders(customerId, vendorId) {
  try {
    const today = getISTDateStr(0)
    const archivesRes = await pool.query(
      `SELECT archive_id, order_date, quantity, delivery_charge_amount, payment_status
       FROM paused_orders_archive
       WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3
       ORDER BY order_date ASC, archive_id ASC`,
      [customerId, vendorId, today]
    )

    for (const arch of archivesRes.rows) {
      const orderRes = await pool.query(
        `INSERT INTO orders
           (customer_id, vendor_id, order_date, quantity, delivery_charge_amount, payment_status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, vendor_id, order_date)
         DO UPDATE SET
           quantity = EXCLUDED.quantity,
           delivery_charge_amount = EXCLUDED.delivery_charge_amount,
           payment_status = EXCLUDED.payment_status
         WHERE orders.is_delivered = false
         RETURNING order_id`,
        [customerId, vendorId, arch.order_date, arch.quantity, arch.delivery_charge_amount, arch.payment_status]
      )

      const orderId = orderRes.rows[0]?.order_id
      if (!orderId) continue

      await pool.query(`DELETE FROM order_items WHERE order_id=$1`, [orderId])
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, quantity, price_at_order, delivery_charge_at_order, order_type)
         SELECT $1, product_id, quantity, price_at_order, delivery_charge_at_order, order_type
         FROM paused_order_items_archive
         WHERE archive_id=$2
         ON CONFLICT (order_id, product_id, order_type)
         DO UPDATE SET
           quantity = EXCLUDED.quantity,
           price_at_order = EXCLUDED.price_at_order,
           delivery_charge_at_order = EXCLUDED.delivery_charge_at_order,
           order_type = EXCLUDED.order_type`,
        [orderId, arch.archive_id]
      )
    }

    await pool.query(
      `DELETE FROM paused_order_items_archive
       WHERE archive_id IN (
         SELECT archive_id FROM paused_orders_archive
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3
       )`,
      [customerId, vendorId, today]
    )
    await pool.query(
      `DELETE FROM paused_orders_archive
       WHERE customer_id=$1 AND vendor_id=$2 AND order_date >= $3`,
      [customerId, vendorId, today]
    )
  } catch (err) {
    console.error("restorePausedOrders dashboard error:", err.message)
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

const paymentUploadDir = path.join(__dirname, "../public/uploads/payments")
if (!fs.existsSync(paymentUploadDir)) fs.mkdirSync(paymentUploadDir, { recursive: true })

const paymentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, paymentUploadDir),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `pay_${Date.now()}${ext}`)
  },
})
const uploadPayment = multer({
  storage: paymentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Images only"))
    cb(null, true)
  },
})

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
        COALESCE(o.payment_status, 'unpaid') AS payment_status,
        o.delivery_charge_amount,
        c.name AS customer_name,
        c.phone,
        cv.address_type,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name || ', ' || a.address || ' - ' || b.block_name || ' - ' || cv.flat_number
          ELSE cv.manual_address
        END AS address,
        o.quantity,
        o.order_date::text AS order_date,
        a.apartment_id,
        a.name   AS apartment_name,
        a.name   AS apartment,
        b.block_id,
        b.block_name,
        COALESCE(
          json_agg(
            json_build_object(
              'item_id',                  oi.item_id,
              'product_name',             p.name,
              'unit',                     p.unit,
              'quantity',                 oi.quantity,
              'price_at_order',           oi.price_at_order,
              'delivery_charge_at_order', oi.delivery_charge_at_order,
              'order_type',               oi.order_type
            ) ORDER BY oi.order_type DESC, oi.item_id
          ) FILTER (WHERE oi.item_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      JOIN customers c ON o.customer_id = c.customer_id
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $1
      LEFT JOIN apartments a ON cv.apartment_id = a.apartment_id
      LEFT JOIN apartment_blocks b ON cv.block_id = b.block_id
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN products p ON p.product_id = oi.product_id
      WHERE o.vendor_id = $1
        AND (
          o.is_delivered = true OR NOT EXISTS (
            SELECT 1
            FROM subscription_pauses sp
            WHERE sp.customer_id = o.customer_id
              AND sp.vendor_id = o.vendor_id
              AND o.order_date >= sp.pause_from
              AND (sp.pause_until IS NULL OR o.order_date <= sp.pause_until)
          )
        )
      GROUP BY o.order_id, o.is_delivered, o.delivered_at, o.payment_status, c.name, c.phone,
               cv.address_type, a.apartment_id, a.name, a.address, b.block_id, b.block_name, cv.flat_number,
               cv.manual_address, o.quantity, o.order_date
      ORDER BY o.order_date DESC
    `, [vendorId])

    const total = await pool.query(`
      SELECT COALESCE(SUM(quantity), 0) total_packets
      FROM orders
      WHERE vendor_id = $1 AND order_date = $2::date
    `, [vendorId, getISTDateStr(1)])

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
      "SELECT is_delivered, COALESCE(payment_status, 'unpaid') AS payment_status FROM orders WHERE order_id = $1 AND vendor_id = $2",
      [req.params.id, vendorId]
    )
    if (result.rowCount === 0) return res.status(404).send("Order not found")

    const currentOrder = result.rows[0]
    const newStatus = !currentOrder.is_delivered

    if (currentOrder.is_delivered && !newStatus && currentOrder.payment_status === "paid") {
      return res.status(400).json({ message: "Paid orders cannot be marked as undelivered" })
    }

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
    const profilePayload = {
      delivery_start: delivery_start || null,
      delivery_end: delivery_end || null,
      order_accept_start: order_accept_start || null,
      order_accept_end: order_accept_end || null,
      active_days: active_days || [0,1,2,3,4,5,6],
    }

    const existingSettings = await pool.query(
      "SELECT auto_generate_time FROM vendor_settings WHERE vendor_id = $1",
      [vendorId]
    )
    const scheduleError = validateSchedule(profilePayload, existingSettings.rows[0] || {})
    if (scheduleError) {
      return res.status(400).json({ message: scheduleError })
    }


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
      profilePayload.delivery_start, profilePayload.delivery_end,
      profilePayload.order_accept_start, profilePayload.order_accept_end,
      profilePayload.active_days,
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
      apply_delivery_charge_on_subscription,
      payment_proof_required,
      max_quantity_per_order,
      is_active,
      auto_generate_time,
      price_per_unit,
      show_phone_numbers,
      adhoc_delivery_charge,
    } = req.body
    const profileResult = await pool.query(
      "SELECT delivery_start, delivery_end, order_accept_start, order_accept_end, active_days FROM vendor_profile WHERE vendor_id = $1",
      [vendorId]
    )
    const profilePayload = profileResult.rows[0] || {}
    const resolvedAutoGenerateTime = auto_generate_time || addMinutesToTime(profilePayload.delivery_end, 120) || null
    const scheduleError = validateSchedule(profilePayload, { auto_generate_time: resolvedAutoGenerateTime })
    if (scheduleError) {
      return res.status(400).json({ message: scheduleError })
    }


    await pool.query(`
      INSERT INTO vendor_settings (vendor_id,
        allow_apartments, allow_houses, allow_blocks,
        require_flat_number, allow_manual_address,
        order_window_enabled, auto_generate_orders,
        notify_on_delivery, notify_pending_eod, apply_delivery_charge_on_subscription,
        payment_proof_required, max_quantity_per_order, is_active,
        auto_generate_time, price_per_unit, show_phone_numbers,
        adhoc_delivery_charge, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, NOW())
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
        apply_delivery_charge_on_subscription = COALESCE($11, vendor_settings.apply_delivery_charge_on_subscription),
        payment_proof_required = COALESCE($12, vendor_settings.payment_proof_required),
        max_quantity_per_order = COALESCE($13, vendor_settings.max_quantity_per_order),
        is_active              = COALESCE($14, vendor_settings.is_active),
        auto_generate_time     = COALESCE($15, vendor_settings.auto_generate_time),
        price_per_unit         = COALESCE($16, vendor_settings.price_per_unit),
        show_phone_numbers     = COALESCE($17, vendor_settings.show_phone_numbers),
        adhoc_delivery_charge  = COALESCE($18, vendor_settings.adhoc_delivery_charge),
        updated_at             = NOW()
    `, [
      vendorId,
      allow_apartments, allow_houses, allow_blocks,
      require_flat_number, allow_manual_address,
      order_window_enabled, auto_generate_orders,
      notify_on_delivery, notify_pending_eod,
      apply_delivery_charge_on_subscription != null ? Boolean(apply_delivery_charge_on_subscription) : null,
      payment_proof_required != null ? Boolean(payment_proof_required) : null,
      max_quantity_per_order, is_active,
      resolvedAutoGenerateTime,
      price_per_unit        != null ? parseFloat(price_per_unit)        : null,
      show_phone_numbers    != null ? Boolean(show_phone_numbers)        : null,
      adhoc_delivery_charge != null ? parseFloat(adhoc_delivery_charge) : null,
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
      const now   = new Date(new Date().getTime() + (new Date().getTimezoneOffset() + 330) * 60000)
      const hhmm  = now.getHours() * 60 + now.getMinutes()
      const [sh, sm] = p.order_accept_start.split(":").map(Number)
      const [eh, em] = p.order_accept_end.split(":").map(Number)
      const start = sh * 60 + sm
      const end   = eh * 60 + em
      is_open     = isWithinTimeWindow(hhmm, start, end)

      const activeDay = getWindowActiveDay(now, start, end)
      if (p.active_days && !p.active_days.includes(activeDay)) {
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
    await generateOrdersForVendor(vendorId, { includeToday: false, includeTomorrow: true })
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
        c.name AS customer_name,
        c.phone,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.name        AS apartment_name,
        a.apartment_id,
        b.block_name,
        b.block_id,
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

    const [custR, ordersR, itemsR, settingsR, profileR] = await Promise.all([
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
        `SELECT order_id, order_date, quantity, is_delivered, delivery_charge_amount,
                COALESCE(payment_status,'unpaid') AS payment_status
         FROM orders
         WHERE customer_id=$1 AND vendor_id=$2 AND order_date>=$3 AND order_date<=$4
         ORDER BY order_date`,
        [req.params.id, vendorId, from, to]
      ),
      pool.query(
        `SELECT oi.order_id, oi.quantity, oi.price_at_order,
                oi.delivery_charge_at_order, oi.order_type,
                p.name AS product_name, p.unit
         FROM order_items oi
         JOIN orders o ON o.order_id = oi.order_id
         JOIN products p ON p.product_id = oi.product_id
         WHERE o.customer_id=$1 AND o.vendor_id=$2
           AND o.order_date>=$3 AND o.order_date<=$4 AND o.is_delivered=true`,
        [req.params.id, vendorId, from, to]
      ),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vendorId]),
      pool.query("SELECT business_name, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id=$1", [vendorId]),
    ])

    if (custR.rowCount === 0) return res.status(404).json({ error: "Customer not found" })

    const itemsByOrder = {}
    for (const it of itemsR.rows) {
      if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = []
      itemsByOrder[it.order_id].push(it)
    }
    const ordersWithItems = ordersR.rows.map(o => ({ ...o, items: itemsByOrder[o.order_id] || [] }))

    const { generateInvoicePDF } = require("../services/invoicePDF")
    const pdfBuffer = await generateInvoicePDF(
      {
        customer:       custR.rows[0],
        orders:         ordersWithItems,
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

    const [orders, items, settings, profile] = await Promise.all([
      pool.query(`
        SELECT order_id, order_date, quantity, is_delivered, delivered_at, delivery_charge_amount,
               COALESCE(payment_status, 'unpaid') AS payment_status
        FROM orders
        WHERE customer_id = $1 AND vendor_id = $2
          AND order_date >= $3 AND order_date <= $4
        ORDER BY order_date
      `, [req.params.id, vendorId, from, to]),
      pool.query(`
        SELECT oi.order_id, oi.quantity, oi.price_at_order,
               oi.delivery_charge_at_order, oi.order_type,
               p.name AS product_name, p.unit
        FROM order_items oi
        JOIN orders o ON o.order_id = oi.order_id
        JOIN products p ON p.product_id = oi.product_id
        WHERE o.customer_id = $1 AND o.vendor_id = $2
          AND o.order_date >= $3 AND o.order_date <= $4
      `, [req.params.id, vendorId, from, to]),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id = $1", [vendorId]),
      pool.query("SELECT business_name, logo_url, whatsapp_number, area, city FROM vendor_profile WHERE vendor_id = $1", [vendorId]),
    ])

    const itemsByOrder = {}
    for (const it of items.rows) {
      if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = []
      itemsByOrder[it.order_id].push(it)
    }
    const ordersWithItems = orders.rows.map(o => ({ ...o, items: itemsByOrder[o.order_id] || [] }))

    res.json({
      customer:       customer.rows[0],
      orders:         ordersWithItems,
      price_per_unit: parseFloat(settings.rows[0]?.price_per_unit || 0),
      vendor:         profile.rows[0] || {},
    })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

/* ══════════════════════════════════════════
   PAYMENTS
══════════════════════════════════════════ */

// GET /payments/:customerId — payment history + outstanding (unpaid delivered orders)
router.get("/payments/:customerId", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)

    const check = await pool.query(
      "SELECT 1 FROM customer_vendor_profile WHERE customer_id=$1 AND vendor_id=$2",
      [req.params.customerId, vendorId]
    )
    if (check.rowCount === 0) return res.status(403).json({ message: "Unauthorized" })

    const [payments, settings, totalR, paymentTotalsR] = await Promise.all([
      pool.query(`
        SELECT payment_id, amount, payment_method, notes, screenshot_url,
               recorded_by, payment_date, created_at,
               period_from, period_to, is_verified, is_revoked
        FROM payments
        WHERE customer_id=$1 AND vendor_id=$2
        ORDER BY payment_date DESC, created_at DESC
      `, [req.params.customerId, vendorId]),
      pool.query("SELECT price_per_unit FROM vendor_settings WHERE vendor_id=$1", [vendorId]),
      pool.query(
        `SELECT COALESCE(SUM(order_total), 0) AS total
         FROM (
           SELECT
             o.order_id,
             COALESCE(SUM(oi.quantity * oi.price_at_order), 0)
             + CASE
                 WHEN COALESCE(MAX(o.delivery_charge_amount), 0) > 0 THEN COALESCE(MAX(o.delivery_charge_amount), 0)
                 ELSE COALESCE(SUM(oi.delivery_charge_at_order), 0)
               END AS order_total
           FROM orders o
           LEFT JOIN order_items oi ON oi.order_id = o.order_id
           WHERE o.customer_id=$1 AND o.vendor_id=$2 AND o.is_delivered=true
           GROUP BY o.order_id
         ) totals`,
        [req.params.customerId, vendorId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM payments
         WHERE customer_id=$1
           AND vendor_id=$2
           AND COALESCE(is_verified, false)=true
           AND COALESCE(is_revoked, false)=false`,
        [req.params.customerId, vendorId]
      )
    ])

    const pricePerUnit = parseFloat(settings.rows[0]?.price_per_unit || 0)
    const totalBilled  = parseFloat(totalR.rows[0].total || 0)
    const totalPaid    = parseFloat(paymentTotalsR.rows[0].total || 0)
    const outstanding  = Math.max(totalBilled - totalPaid, 0)

    res.json({ payments: payments.rows, totalBilled, totalPaid, outstanding, pricePerUnit })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// GET /payments-history — all payments + customer billing summary for a date range
router.get("/payments-history", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const from = req.query.from
    const to = req.query.to

    if (!from || !to) {
      return res.status(400).json({ message: "from and to are required" })
    }

    const [paymentsRes, balancesRes] = await Promise.all([
      pool.query(`
        SELECT
          p.payment_id, p.customer_id, p.amount, p.payment_method, p.notes, p.screenshot_url,
          p.recorded_by, p.payment_date, p.created_at, p.period_from, p.period_to,
          p.is_verified, p.is_revoked,
          c.name AS customer_name,
          c.phone AS customer_phone,
          cv.address_type,
          cv.flat_number,
          cv.manual_address,
          a.apartment_id,
          a.name AS apartment_name,
          b.block_id,
          b.block_name,
          CASE
            WHEN cv.address_type='apartment'
              THEN CONCAT_WS(', ',
                NULLIF(CONCAT('Flat ', cv.flat_number), 'Flat '),
                NULLIF(CONCAT('Block ', b.block_name), 'Block '),
                a.name
              )
            ELSE COALESCE(cv.manual_address, '')
          END AS address
        FROM payments p
        JOIN customers c ON c.customer_id = p.customer_id
        LEFT JOIN customer_vendor_profile cv
          ON cv.customer_id = p.customer_id AND cv.vendor_id = p.vendor_id
        LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
        LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
        WHERE p.vendor_id = $1
          AND p.payment_date >= $2
          AND p.payment_date <= $3
        ORDER BY p.payment_date DESC, p.created_at DESC, p.payment_id DESC
      `, [vendorId, from, to]),
      pool.query(`
        WITH delivered_order_totals AS (
          SELECT
            o.customer_id,
            o.payment_status,
            COALESCE(SUM(oi.quantity * oi.price_at_order), 0)
            + CASE
                WHEN COALESCE(MAX(o.delivery_charge_amount), 0) > 0 THEN COALESCE(MAX(o.delivery_charge_amount), 0)
                ELSE COALESCE(SUM(oi.delivery_charge_at_order), 0)
              END AS order_total
          FROM orders o
          LEFT JOIN order_items oi ON oi.order_id = o.order_id
          WHERE o.vendor_id = $1
            AND o.is_delivered = true
            AND o.order_date >= $2
            AND o.order_date <= $3
          GROUP BY o.order_id, o.customer_id, o.payment_status
        ),
        order_totals AS (
          SELECT
            customer_id,
            COALESCE(SUM(order_total), 0) AS total_billed
          FROM delivered_order_totals
          GROUP BY customer_id
        ),
        payment_totals AS (
          SELECT
            customer_id,
            COALESCE(SUM(CASE WHEN COALESCE(is_verified, false) = true AND COALESCE(is_revoked, false) = false THEN amount ELSE 0 END), 0) AS received_amount
          FROM payments
          WHERE vendor_id = $1
            AND payment_date >= $2
            AND payment_date <= $3
          GROUP BY customer_id
        )
        SELECT
          c.customer_id,
          c.name AS customer_name,
          c.phone AS customer_phone,
          cv.address_type,
          cv.flat_number,
          cv.manual_address,
          a.apartment_id,
          a.name AS apartment_name,
          b.block_id,
          b.block_name,
          CASE
            WHEN cv.address_type='apartment'
              THEN CONCAT_WS(', ',
                NULLIF(CONCAT('Flat ', cv.flat_number), 'Flat '),
                NULLIF(CONCAT('Block ', b.block_name), 'Block '),
                a.name
              )
            ELSE COALESCE(cv.manual_address, '')
          END AS address,
          COALESCE(ot.total_billed, 0) AS total_billed,
          COALESCE(pt.received_amount, 0) AS received_amount,
          GREATEST(COALESCE(ot.total_billed, 0) - COALESCE(pt.received_amount, 0), 0) AS outstanding
        FROM customer_vendor_profile cv
        JOIN customers c ON c.customer_id = cv.customer_id
        LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
        LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
        LEFT JOIN order_totals ot ON ot.customer_id = cv.customer_id
        LEFT JOIN payment_totals pt ON pt.customer_id = cv.customer_id
        WHERE cv.vendor_id = $1
          AND (
            COALESCE(ot.total_billed, 0) > 0
            OR COALESCE(pt.received_amount, 0) > 0
            OR GREATEST(COALESCE(ot.total_billed, 0) - COALESCE(pt.received_amount, 0), 0) > 0
          )
        ORDER BY GREATEST(COALESCE(ot.total_billed, 0) - COALESCE(pt.received_amount, 0), 0) DESC, c.name ASC
      `, [vendorId, from, to]),
    ])

    res.json({
      payments: paymentsRes.rows,
      customerTotals: balancesRes.rows,
    })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// POST /upload-payment-screenshot — upload image, return URL
router.post("/upload-payment-screenshot", requireAdmin, uploadPayment.single("screenshot"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" })
    const url = `${req.protocol}://${req.get("host")}/uploads/payments/${req.file.filename}`
    res.json({ screenshot_url: url })
  } catch (err) {
    console.error(err)
    res.status(500).json({ message: err.message })
  }
})

// POST /payments — vendor records a payment and marks orders as paid for the period
router.post("/payments", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { customer_id, amount, payment_method, notes, screenshot_url, payment_date, period_from, period_to } = req.body

    if (!customer_id || !amount) return res.status(400).json({ message: "customer_id and amount required" })

    const check = await pool.query(
      "SELECT 1 FROM customer_vendor_profile WHERE customer_id=$1 AND vendor_id=$2",
      [customer_id, vendorId]
    )
    if (check.rowCount === 0) return res.status(403).json({ message: "Unauthorized" })

    const result = await pool.query(`
      INSERT INTO payments (customer_id, vendor_id, amount, payment_method, notes, screenshot_url,
                            recorded_by, payment_date, period_from, period_to, is_verified)
      VALUES ($1,$2,$3,$4,$5,$6,'vendor',$7,$8,$9,true)
      RETURNING payment_id, amount, payment_method, payment_date, created_at
    `, [
      customer_id, vendorId,
      parseFloat(amount),
      payment_method || "cash",
      notes || null,
      screenshot_url || null,
      payment_date || getISTDateStr(0),
      period_from || null,
      period_to   || null,
    ])

    // Mark covered orders as paid
    if (period_from && period_to) {
      await pool.query(`
        UPDATE orders SET payment_status='paid'
        WHERE customer_id=$1 AND vendor_id=$2
          AND order_date>=$3 AND order_date<=$4
          AND is_delivered=true AND COALESCE(payment_status,'unpaid')='unpaid'
      `, [customer_id, vendorId, period_from, period_to])
    }

    res.json({ message: "Payment recorded", payment: result.rows[0] })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// PATCH /payments/:paymentId/verify — vendor confirms the payment is genuine
router.patch("/payments/:paymentId/verify", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const paymentRes = await pool.query(
      "UPDATE payments SET is_verified=true, is_revoked=false WHERE payment_id=$1 AND vendor_id=$2 RETURNING payment_id, customer_id, period_from, period_to",
      [req.params.paymentId, vendorId]
    )
    if (paymentRes.rowCount === 0) return res.status(404).json({ message: "Payment not found" })
    const { customer_id, period_from, period_to } = paymentRes.rows[0]

    if (period_from && period_to) {
      await pool.query(`
        UPDATE orders
        SET payment_status='paid'
        WHERE customer_id=$1 AND vendor_id=$2
          AND order_date >= $3 AND order_date <= $4
          AND is_delivered=true
      `, [customer_id, vendorId, period_from, period_to])
    }

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// PATCH /payments/:paymentId/revoke — vendor revokes: marks payment revoked + orders back to unpaid
router.patch("/payments/:paymentId/revoke", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const payR = await pool.query(
      "SELECT customer_id, period_from, period_to FROM payments WHERE payment_id=$1 AND vendor_id=$2",
      [req.params.paymentId, vendorId]
    )
    if (payR.rowCount === 0) return res.status(404).json({ message: "Payment not found" })

    const { customer_id, period_from, period_to } = payR.rows[0]

    await pool.query(
      "UPDATE payments SET is_revoked=true, is_verified=false WHERE payment_id=$1",
      [req.params.paymentId]
    )

    // Flip orders back to unpaid for the period this payment covered
    if (period_from && period_to) {
      await pool.query(`
        UPDATE orders SET payment_status='unpaid'
        WHERE customer_id=$1 AND vendor_id=$2
          AND order_date>=$3 AND order_date<=$4
          AND is_delivered=true AND payment_status='paid'
      `, [customer_id, vendorId, period_from, period_to])
    }

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).send("Error")
  }
})

// DELETE /payments/:paymentId — remove payment entry (also revokes orders if period set)
router.delete("/payments/:paymentId", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const payR = await pool.query(
      "SELECT customer_id, period_from, period_to FROM payments WHERE payment_id=$1 AND vendor_id=$2",
      [req.params.paymentId, vendorId]
    )
    if (payR.rowCount === 0) return res.status(404).json({ message: "Payment not found" })

    const { customer_id, period_from, period_to } = payR.rows[0]
    await pool.query("DELETE FROM payments WHERE payment_id=$1", [req.params.paymentId])

    if (period_from && period_to) {
      await pool.query(`
        UPDATE orders SET payment_status='unpaid'
        WHERE customer_id=$1 AND vendor_id=$2
          AND order_date>=$3 AND order_date<=$4
          AND is_delivered=true AND payment_status='paid'
      `, [customer_id, vendorId, period_from, period_to])
    }

    res.json({ success: true })
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
        sp.pause_from::text AS pause_from,
        sp.pause_until::text AS pause_until,
        sp.created_at,
        c.name AS customer_name,
        c.phone,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.apartment_id,
        a.name       AS apartment_name,
        b.block_id,
        b.block_name
      FROM subscription_pauses sp
      JOIN customers c ON c.customer_id = sp.customer_id
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = sp.customer_id AND cv.vendor_id = sp.vendor_id
      LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
      LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
      WHERE sp.vendor_id = $1
        AND (sp.pause_until IS NULL OR sp.pause_until >= $2::date)
      ORDER BY sp.pause_from DESC, sp.pause_id DESC
    `, [vendorId, getISTDateStr(0)])
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
      "DELETE FROM subscription_pauses WHERE pause_id=$1 AND vendor_id=$2 RETURNING pause_id, customer_id",
      [req.params.pauseId, vendorId]
    )
    if (result.rowCount === 0) return res.status(404).json({ error: "Pause not found" })
    await restorePausedOrders(result.rows[0].customer_id, vendorId)
    await generateOrdersForVendor(vendorId, { includeToday: false, includeTomorrow: true })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ══════════════════════════════════════════
   PRODUCTS
══════════════════════════════════════════ */

// GET /products — list all vendor products
router.get("/products", async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      SELECT product_id, name, unit, price, delivery_charge, order_type, is_active, sort_order, created_at
      FROM products
      WHERE vendor_id = $1
      ORDER BY sort_order, product_id
    `, [vendorId])
    res.json({ products: rows })
  } catch (e) {
    res.status(401).json({ message: e.message })
  }
})

// POST /products — create product
router.post("/products", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { name, unit = "", price, delivery_charge = 0, order_type = "both", sort_order = 0 } = req.body
    if (!name || price == null) return res.status(400).json({ message: "name and price are required" })

    const { rows } = await pool.query(`
      INSERT INTO products (vendor_id, name, unit, price, delivery_charge, order_type, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [vendorId, name.trim(), unit.trim(), price, delivery_charge, order_type, sort_order])

    const product = rows[0]
      await pool.query(`
        INSERT INTO product_price_history (product_id, price, delivery_charge, effective_from)
        VALUES ($1,$2,$3,$4)
    `, [product.product_id, price, delivery_charge, getISTDateStr(0)])

    res.json({ product })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: e.message })
  }
})

// PUT /products/:id — update product (saves price history if price changed)
router.put("/products/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { name, unit = "", price, delivery_charge = 0, order_type, is_active, sort_order = 0 } = req.body

    const { rows: old } = await pool.query(
      `SELECT price, delivery_charge FROM products WHERE product_id=$1 AND vendor_id=$2`,
      [req.params.id, vendorId]
    )
    if (!old.length) return res.status(404).json({ message: "Product not found" })

    const { rows } = await pool.query(`
      UPDATE products
      SET name=$1, unit=$2, price=$3, delivery_charge=$4, order_type=$5, is_active=$6, sort_order=$7
      WHERE product_id=$8 AND vendor_id=$9
      RETURNING *
    `, [name.trim(), unit.trim(), price, delivery_charge, order_type, is_active, sort_order, req.params.id, vendorId])

    const priceChanged =
      parseFloat(old[0].price)            !== parseFloat(price) ||
      parseFloat(old[0].delivery_charge)  !== parseFloat(delivery_charge)

    if (priceChanged) {
      await pool.query(`
        INSERT INTO product_price_history (product_id, price, delivery_charge, effective_from)
        VALUES ($1,$2,$3,$4)
      `, [req.params.id, price, delivery_charge, getISTDateStr(0)])
    }

    res.json({ product: rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ message: e.message })
  }
})

// PATCH /products/:id/toggle — toggle active/inactive
router.patch("/products/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      UPDATE products SET is_active = NOT is_active
      WHERE product_id=$1 AND vendor_id=$2
      RETURNING is_active
    `, [req.params.id, vendorId])
    if (!rows.length) return res.status(404).json({ message: "Product not found" })
    res.json({ is_active: rows[0].is_active })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

// DELETE /products/:id
router.delete("/products/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    await pool.query(
      `DELETE FROM products WHERE product_id=$1 AND vendor_id=$2`,
      [req.params.id, vendorId]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

// GET /products/:id/price-history
router.get("/products/:id/price-history", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const check = await pool.query(
      `SELECT 1 FROM products WHERE product_id=$1 AND vendor_id=$2`,
      [req.params.id, vendorId]
    )
    if (!check.rowCount) return res.status(404).json({ message: "Not found" })
    const { rows } = await pool.query(`
      SELECT history_id, price, delivery_charge, effective_from, created_at
      FROM product_price_history
      WHERE product_id=$1
      ORDER BY effective_from DESC, created_at DESC
    `, [req.params.id])
    res.json({ history: rows })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

/* ══════════════════════════════════════════
   CUSTOMER SUBSCRIPTIONS (per product)
══════════════════════════════════════════ */

// GET /customer-subscriptions/:customerId — list per-product subscriptions
router.get("/customer-subscriptions/:customerId", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      SELECT cs.subscription_id, cs.product_id, cs.quantity, cs.is_active, cs.created_at,
             p.name, p.unit, p.price, p.delivery_charge, p.order_type, p.is_active AS product_active
      FROM customer_subscriptions cs
      JOIN products p ON p.product_id = cs.product_id
      WHERE cs.customer_id=$1 AND cs.vendor_id=$2
      ORDER BY p.sort_order, p.product_id
    `, [req.params.customerId, vendorId])
    res.json({ subscriptions: rows })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

// POST /customer-subscriptions — upsert subscription
router.post("/customer-subscriptions", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { customer_id, product_id, quantity = 1, is_active = true } = req.body
    const { rows } = await pool.query(`
      INSERT INTO customer_subscriptions (customer_id, vendor_id, product_id, quantity, is_active)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (customer_id, product_id)
      DO UPDATE SET quantity=$4, is_active=$5
      RETURNING *
    `, [customer_id, vendorId, product_id, quantity, is_active])

    // Ensure base subscription is active when adding a product sub
    if (is_active) {
      await pool.query(`
        INSERT INTO subscriptions (customer_id, vendor_id, quantity, status)
        VALUES ($1,$2,$3,'active')
        ON CONFLICT (customer_id, vendor_id) DO UPDATE SET status='active'
      `, [customer_id, vendorId, quantity])
    }

    res.json({ subscription: rows[0] })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

// DELETE /customer-subscriptions/:id — remove product subscription
router.delete("/customer-subscriptions/:id", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    await pool.query(
      `DELETE FROM customer_subscriptions WHERE subscription_id=$1 AND vendor_id=$2`,
      [req.params.id, vendorId]
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

/* ══════════════════════════════════════════
   ORDER ITEMS
══════════════════════════════════════════ */

// GET /orders/:id/items — get line items for an order
router.get("/orders/:id/items", async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      SELECT oi.item_id, oi.product_id, oi.quantity, oi.price_at_order,
             oi.delivery_charge_at_order, oi.order_type, oi.created_at,
             p.name AS product_name, p.unit
      FROM order_items oi
      JOIN products p ON p.product_id = oi.product_id
      JOIN orders o   ON o.order_id   = oi.order_id
      WHERE oi.order_id = $1 AND o.vendor_id = $2
      ORDER BY oi.order_type DESC, oi.item_id
    `, [req.params.id, vendorId])
    res.json({ items: rows })
  } catch (e) {
    res.status(401).json({ message: e.message })
  }
})

/* ══════════════════════════════════════════
   MESSAGES INBOX
══════════════════════════════════════════ */

// GET /messages — latest message per phone (conversation list)
router.get("/messages", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (m.phone)
        m.message_id, m.phone, m.content, m.message_type, m.direction,
        m.created_at, m.is_read, m.customer_id,
        c.phone AS customer_phone,
        c.name AS customer_name,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.apartment_id,
        a.name AS apartment_name,
        b.block_id,
        b.block_name,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name
            || COALESCE(' - ' || b.block_name, '')
            || COALESCE(' - Flat ' || cv.flat_number, '')
          ELSE COALESCE(cv.manual_address, '')
        END AS address
      FROM messages m
      LEFT JOIN customers c
        ON c.customer_id = m.customer_id
        OR (m.customer_id IS NULL AND c.phone = m.phone)
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $1
      LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
      LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
      WHERE m.vendor_id = $1
      ORDER BY m.phone, m.created_at DESC
    `, [vendorId])

    // Count unread per phone
    const { rows: unread } = await pool.query(`
      SELECT phone, COUNT(*) AS cnt
      FROM messages
      WHERE vendor_id=$1 AND direction='inbound' AND is_read=false
      GROUP BY phone
    `, [vendorId])
    const unreadMap = {}
    unread.forEach(r => { unreadMap[r.phone] = parseInt(r.cnt) })

    const conversations = rows
      .map(r => ({ ...r, unread_count: unreadMap[r.phone] || 0 }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    res.json({ conversations })
  } catch (e) {
    res.status(401).json({ message: e.message })
  }
})

// GET /messages/unread-count
router.get("/messages/unread-count", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { rows } = await pool.query(`
      SELECT COUNT(DISTINCT phone) AS count
      FROM messages
      WHERE vendor_id=$1 AND direction='inbound' AND is_read=false
    `, [vendorId])
    res.json({ count: parseInt(rows[0].count) })
  } catch (e) {
    res.status(401).json({ message: e.message })
  }
})

// GET /messages/:phone — full conversation thread (marks as read)
router.get("/messages/thread/:phone", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const phone    = decodeURIComponent(req.params.phone)
    const { rows } = await pool.query(`
      SELECT message_id, direction, message_type, content, media_id, is_read, created_at
      FROM messages
      WHERE vendor_id=$1 AND phone=$2
      ORDER BY created_at ASC
    `, [vendorId, phone])

    await pool.query(
      `UPDATE messages SET is_read=true WHERE vendor_id=$1 AND phone=$2 AND direction='inbound'`,
      [vendorId, phone]
    )

    const meta = await pool.query(`
      SELECT
        c.customer_id,
        c.name AS customer_name,
        c.phone,
        cv.address_type,
        cv.flat_number,
        cv.manual_address,
        a.apartment_id,
        a.name AS apartment_name,
        b.block_id,
        b.block_name,
        CASE
          WHEN cv.address_type = 'apartment'
          THEN a.name
            || COALESCE(' - ' || b.block_name, '')
            || COALESCE(' - Flat ' || cv.flat_number, '')
          ELSE COALESCE(cv.manual_address, '')
        END AS address
      FROM customers c
      LEFT JOIN customer_vendor_profile cv
        ON cv.customer_id = c.customer_id AND cv.vendor_id = $1
      LEFT JOIN apartments a ON a.apartment_id = cv.apartment_id
      LEFT JOIN apartment_blocks b ON b.block_id = cv.block_id
      WHERE c.phone = $2
      LIMIT 1
    `, [vendorId, phone])

    res.json({ messages: rows, phone, conversation: meta.rows[0] || { phone } })
  } catch (e) {
    res.status(401).json({ message: e.message })
  }
})

router.post("/messages/thread/:phone/reply", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const phone = decodeURIComponent(req.params.phone)
    const text = String(req.body?.text || "").trim()
    if (!text) return res.status(400).json({ message: "Reply text is required" })

    const vendorRes = await pool.query(
      "SELECT phone_number_id FROM vendors WHERE vendor_id = $1 LIMIT 1",
      [vendorId]
    )
    const phoneNumberId = vendorRes.rows[0]?.phone_number_id
    if (!phoneNumberId) {
      return res.status(400).json({ message: "Vendor phone number is not configured" })
    }

    const customerRes = await pool.query(
      "SELECT customer_id FROM customers WHERE phone = $1 LIMIT 1",
      [phone]
    )
    const customerId = customerRes.rows[0]?.customer_id || null

    const waRes = await sendVendorWhatsAppText(phoneNumberId, phone, text)
    const mediaId = waRes?.messages?.[0]?.id || null

    const saved = await pool.query(`
      INSERT INTO messages (vendor_id, customer_id, phone, direction, message_type, content, media_id, is_read)
      VALUES ($1,$2,$3,'outbound','text',$4,$5,true)
      RETURNING message_id, direction, message_type, content, media_id, is_read, created_at
    `, [vendorId, customerId, phone, text, mediaId])

    res.json({ success: true, message: saved.rows[0] })
  } catch (e) {
    const details = e.response?.data?.error?.message || e.message
    res.status(400).json({ message: details })
  }
})

/* ══════════════════════════════════════════
   WHATSAPP FLOW DATA EXCHANGE ENDPOINT
══════════════════════════════════════════ */

router.get("/notices/config", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const [templatesRes, reasonsRes, audienceRows] = await Promise.all([
      pool.query(
        `SELECT template_key, template_name, display_name, template_category, header_text, body_text, variable_schema, sort_order
         FROM whatsapp_notice_templates
         WHERE is_active = true
         ORDER BY sort_order, notice_template_id`
      ),
      pool.query(
        `SELECT reason_code, display_name, message_text, sort_order
         FROM whatsapp_notice_reasons
         WHERE is_active = true
         ORDER BY sort_order, reason_id`
      ),
      getNoticeAudience(vendorId, { from: getISTDateStr(0), to: getISTDateStr(0) }),
    ])

    const apartments = audienceRows
      .filter((row) => row.address_type === "apartment" && row.apartment_id)
      .reduce((acc, row) => {
        if (!acc.some((item) => String(item.apartment_id) === String(row.apartment_id))) {
          acc.push({ apartment_id: row.apartment_id, apartment_name: row.apartment_name })
        }
        return acc
      }, [])
    res.json({ templates: templatesRes.rows, reasons: reasonsRes.rows, apartments })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

router.get("/notices/audience", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const { from, to, location_id = "", block_id = "", template_key = "" } = req.query
    if (!from || !to) return res.status(400).json({ message: "from and to are required" })

    const allRows = await getNoticeAudience(vendorId, { from, to })
    const onlyNotPaid = template_key === "payment_due_reminder"
    const customers = applyNoticeFilters(allRows, { locationId: location_id, blockId: block_id, onlyNotPaid })
    const blocks = location_id && location_id !== "__individual__"
      ? allRows
          .filter((row) => String(row.apartment_id || "") === String(location_id) && row.block_id)
          .reduce((acc, row) => {
            if (!acc.some((item) => String(item.block_id) === String(row.block_id))) {
              acc.push({ block_id: row.block_id, block_name: row.block_name })
            }
            return acc
          }, [])
      : []

    const summary = customers.reduce((acc, row) => {
      acc.totalCustomers += 1
      acc.notPaidCustomers += Number.parseFloat(row.outstanding || 0) > 0 ? 1 : 0
      acc.totalOutstanding += Number.parseFloat(row.outstanding || 0) || 0
      return acc
    }, { totalCustomers: 0, notPaidCustomers: 0, totalOutstanding: 0 })

    res.json({ customers, blocks, summary })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

router.get("/notices/history", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const result = await pool.query(
      `SELECT
         b.notice_batch_id,
         b.template_key,
         t.display_name AS template_display_name,
         b.reason_code,
         r.display_name AS reason_display_name,
         b.filter_from,
         b.filter_to,
         b.notice_date,
         b.notice_from,
         b.notice_to,
         b.total_recipients,
         b.sent_count,
         b.failed_count,
         b.status,
         b.created_on
       FROM vendor_notice_batches b
       LEFT JOIN whatsapp_notice_templates t ON t.template_key = b.template_key
       LEFT JOIN whatsapp_notice_reasons r ON r.reason_code = b.reason_code
       WHERE b.vendor_id = $1
       ORDER BY b.created_on DESC, b.notice_batch_id DESC
       LIMIT 50`,
      [vendorId]
    )
    res.json({ history: result.rows })
  } catch (e) {
    res.status(500).json({ message: e.message })
  }
})

router.post("/notices/send", requireAdmin, async (req, res) => {
  try {
    const vendorId = getVendorId(req)
    const {
      template_key,
      reason_code,
      notice_date,
      notice_from,
      notice_to,
      filter_from,
      filter_to,
      location_id = null,
      block_id = null,
      recipient_ids = [],
    } = req.body || {}

    const template = await getNoticeTemplateByKey(template_key)
    if (!template) return res.status(400).json({ message: "Invalid template" })

    const from = normalizeDateOnly(filter_from)
    const to = normalizeDateOnly(filter_to)
    if (!from || !to) return res.status(400).json({ message: "Filter range is required" })

    let reason = null
    if (template_key === "delivery_unavailable_date" || template_key === "delivery_unavailable_from_to") {
      reason = await getNoticeReasonByCode(reason_code)
      if (!reason) return res.status(400).json({ message: "Invalid reason" })
    }

    const recipientIdSet = new Set((Array.isArray(recipient_ids) ? recipient_ids : []).map((id) => String(id)).filter(Boolean))
    if (!recipientIdSet.size) return res.status(400).json({ message: "recipient_ids are required" })

    const allRows = await getNoticeAudience(vendorId, { from, to })
    const onlyNotPaid = template_key === "payment_due_reminder"
    const recipients = applyNoticeFilters(allRows, { locationId: location_id, blockId: block_id, onlyNotPaid })
      .filter((row) => recipientIdSet.has(String(row.customer_id)) && row.customer_phone)
    if (!recipients.length) return res.status(400).json({ message: "No customers match the selected filters" })

    const vendorRes = await pool.query("SELECT phone_number_id FROM vendors WHERE vendor_id = $1 LIMIT 1", [vendorId])
    const phoneNumberId = vendorRes.rows[0]?.phone_number_id
    if (!phoneNumberId) return res.status(400).json({ message: "Vendor phone number is not configured" })

    const batchRes = await pool.query(
      `INSERT INTO vendor_notice_batches
         (vendor_id, template_key, reason_code, filter_from, filter_to, notice_date, notice_from, notice_to, location_apartment_id, location_block_id, search_text, recipient_scope, total_recipients, created_by_vendor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'filtered',$12,$1)
       RETURNING notice_batch_id`,
      [
        vendorId,
        template_key,
        reason_code || null,
        from,
        to,
        normalizeDateOnly(notice_date),
        normalizeDateOnly(notice_from),
        normalizeDateOnly(notice_to),
        location_id && location_id !== "__individual__" ? location_id : null,
        block_id || null,
        null,
        recipients.length,
      ]
    )
    const noticeBatchId = batchRes.rows[0].notice_batch_id

    let sentCount = 0
    let failedCount = 0
    const failedRecipients = []

    for (const row of recipients) {
      let params = []
      if (template_key === "delivery_unavailable_date") {
        const dateValue = normalizeDateOnly(notice_date)
        if (!dateValue) throw new Error("Delivery date is required")
        params = [formatISTDate(dateValue), reason.message_text]
      } else if (template_key === "delivery_unavailable_from_to") {
        const fromValue = normalizeDateOnly(notice_from)
        const toValue = normalizeDateOnly(notice_to)
        if (!fromValue || !toValue) throw new Error("From and To dates are required")
        params = [formatISTDate(fromValue), formatISTDate(toValue), reason.message_text]
      } else if (template_key === "payment_due_reminder") {
        const outstanding = Number.parseFloat(row.outstanding || 0) || 0
        if (outstanding <= 0) continue
        params = [formatAmount(outstanding), formatISTDate(from), formatISTDate(to)]
      } else {
        throw new Error("Unsupported template")
      }

      try {
        const waRes = await sendVendorWhatsAppTemplate(phoneNumberId, row.customer_phone, template.template_name, params, template.language_code)
        const waMessageId = waRes?.messages?.[0]?.id || null
        await pool.query(
          `INSERT INTO vendor_notice_recipients
             (notice_batch_id, vendor_id, customer_id, phone, template_key, template_name, rendered_params, status, wa_message_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'sent',$8)`,
          [noticeBatchId, vendorId, row.customer_id, row.customer_phone, template_key, template.template_name, JSON.stringify(params), waMessageId]
        )
        sentCount += 1
      } catch (err) {
        const details = err.response?.data?.error?.message || err.message
        failedRecipients.push({
          customer_id: row.customer_id,
          phone: row.customer_phone,
          error: details,
        })
        await pool.query(
          `INSERT INTO vendor_notice_recipients
             (notice_batch_id, vendor_id, customer_id, phone, template_key, template_name, rendered_params, status, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'failed',$8)`,
          [noticeBatchId, vendorId, row.customer_id, row.customer_phone, template_key, template.template_name, JSON.stringify(params), details]
        )
        failedCount += 1
      }
    }

    await pool.query(
      `UPDATE vendor_notice_batches
       SET sent_count = $2,
           failed_count = $3,
           status = $4,
           modified_on = NOW()
       WHERE notice_batch_id = $1`,
      [noticeBatchId, sentCount, failedCount, failedCount > 0 && sentCount === 0 ? "failed" : "completed"]
    )

    res.json({
      success: true,
      notice_batch_id: noticeBatchId,
      sent_count: sentCount,
      failed_count: failedCount,
      failed_recipients: failedRecipients,
    })
  } catch (e) {
    res.status(400).json({ message: e.message })
  }
})

const crypto = require("crypto")
const fs_    = require("fs")
const path_  = require("path")

// Load private key — env variable takes priority (Railway), fallback to file (local dev)
let FLOW_PRIVATE_KEY = null
if (process.env.FLOW_PRIVATE_KEY) {
  // Railway: newlines stored as \n literal in env var
  FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY.replace(/\\n/g, "\n")
} else {
  try {
    FLOW_PRIVATE_KEY = fs_.readFileSync(path_.join(__dirname, "../private.pem"), "utf8")
  } catch {
    console.warn("⚠️  private.pem not found — WhatsApp Flow decryption will not work")
  }
}

function decryptFlowRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body

  // 1. Decrypt the AES key using our RSA private key
  const decryptedAesKey = crypto.privateDecrypt(
    { key: FLOW_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  )

  // 2. Decrypt the flow data using AES-128-GCM
  const iv        = Buffer.from(initial_vector, "base64")
  const encrypted = Buffer.from(encrypted_flow_data, "base64")
  const TAG_LENGTH = 16
  const encData   = encrypted.subarray(0, -TAG_LENGTH)
  const authTag   = encrypted.subarray(-TAG_LENGTH)

  const decipher  = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encData), decipher.final()])
  return { decryptedAesKey, iv, payload: JSON.parse(decrypted.toString("utf8")) }
}

function encryptFlowResponse(responseData, aesKey, iv) {
  // Flip the IV for response
  const flippedIv = Buffer.from(iv.map((b) => ~b & 0xff))
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseData), "utf8"), cipher.final()])
  const tag       = cipher.getAuthTag()
  return Buffer.concat([encrypted, tag]).toString("base64")
}

async function getRegistrationPrefill(flowToken) {
  const parts = String(flowToken || "").split(":")
  const vendorId = parseInt(parts[0], 10)
  const customerId = parseInt(parts[1], 10)
  const mode = parts[2] || "new"

  if (!vendorId) {
    return { vendorId: null, mode, customer: null, profile: null, apartments: [] }
  }

  const apartmentsRes = await pool.query(
    "SELECT apartment_id, name FROM apartments WHERE vendor_id=$1 ORDER BY name",
    [vendorId]
  )

  if (!customerId) {
    return {
      vendorId,
      mode,
      customer: null,
      profile: null,
      apartments: apartmentsRes.rows,
    }
  }

  const [customerRes, profileRes] = await Promise.all([
    pool.query("SELECT customer_id, name FROM customers WHERE customer_id=$1", [customerId]),
    pool.query(`
      SELECT cv.address_type, cv.apartment_id, cv.block_id, cv.flat_number, cv.manual_address
      FROM customer_vendor_profile cv
      WHERE cv.customer_id=$1 AND cv.vendor_id=$2
      LIMIT 1
    `, [customerId, vendorId]),
  ])

  return {
    vendorId,
    mode,
    customer: customerRes.rows[0] || null,
    profile: profileRes.rows[0] || null,
    apartments: apartmentsRes.rows,
  }
}

router.post("/whatsapp-flow-data", async (req, res) => {
  try {
    if (!FLOW_PRIVATE_KEY) {
      return res.status(500).send("Private key not configured")
    }

    let rawBody = req.body
    if (Buffer.isBuffer(rawBody)) rawBody = rawBody.toString("utf8")
    const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody

    // Decrypt every request (ping is also encrypted per Meta spec)
    const { decryptedAesKey, iv, payload } = decryptFlowRequest(parsed)
    const { action, screen, data: flowData } = payload
    console.log("[REG FLOW RECV]", JSON.stringify({
      action,
      screen: screen || null,
      flow_token: payload?.flow_token || null,
      data_keys: Object.keys(flowData || {}),
      data: flowData || {}
    }, null, 2))

    let responsePayload = {}

    if (action === "ping") {
      // Health check — respond with status active
      responsePayload = { data: { status: "active" } }

    } else if (action === "INIT" || action === "data_exchange") {

      if (action === "INIT") {
        const prefill = await getRegistrationPrefill(payload.flow_token)
        const currentName = prefill.customer?.name || ""
        const addressType = prefill.profile?.address_type || ""
        const initData = {}

        if (currentName) initData.customer_name = currentName
        if (addressType) initData.address_type = addressType
        if (prefill.profile?.apartment_id) initData.apartment_id = String(prefill.profile.apartment_id)
        if (prefill.profile?.block_id) initData.block_id = String(prefill.profile.block_id)
        if (prefill.profile?.flat_number) initData.flat_number = prefill.profile.flat_number
        if (prefill.profile?.manual_address) initData.manual_address = prefill.profile.manual_address

        responsePayload = {
          screen: "WELCOME",
          data: initData,
        }
        console.log("[REG FLOW RESP INIT]", JSON.stringify(responsePayload, null, 2))

      } else if (screen === "WELCOME") {
        // User submitted name + address type
        const prefill = await getRegistrationPrefill(payload.flow_token)
        const addressType  = flowData?.address_type
        const customerName = String(flowData?.customer_name || "").trim()

        if (addressType === "apartment") {
          const selectedApartmentId = flowData?.apartment_id || (prefill.profile?.apartment_id ? String(prefill.profile.apartment_id) : "")
          const apartmentData = {
            customer_name: customerName,
            apartments: prefill.apartments.map((a) => ({ id: String(a.apartment_id), title: a.name })),
          }
          if (selectedApartmentId) apartmentData.apartment_id = selectedApartmentId

          responsePayload = {
            screen: "APARTMENT_ADDRESS",
            data: apartmentData,
          }
        } else {
          // House — go straight to manual address screen
          const houseData = {
            customer_name: customerName,
          }
          if (flowData?.manual_address || prefill.profile?.manual_address) {
            houseData.manual_address = flowData?.manual_address || prefill.profile?.manual_address || ""
          }
          responsePayload = {
            screen: "HOUSE_ADDRESS",
            data: houseData,
          }
        }
        console.log("[REG FLOW RESP WELCOME]", JSON.stringify(responsePayload, null, 2))

      } else if (screen === "APARTMENT_ADDRESS") {
        // User selected apartment — load blocks
        const aptId = flowData?.apartment_id
        const prefill = await getRegistrationPrefill(payload.flow_token)
        const { rows: blockRows } = await pool.query(
          "SELECT block_id, block_name FROM apartment_blocks WHERE apartment_id=$1 ORDER BY block_name",
          [aptId]
        )
        const blockId = prefill.profile?.apartment_id && String(prefill.profile.apartment_id) === String(aptId)
          ? (prefill.profile?.block_id ? String(prefill.profile.block_id) : "")
          : ""
        const flatNumber = prefill.profile?.apartment_id && String(prefill.profile.apartment_id) === String(aptId)
          ? (prefill.profile?.flat_number || "")
          : ""
        const blockData = {
          customer_name: flowData?.customer_name || "",
          apartment_id: aptId,
          blocks: blockRows.map((b) => ({ id: String(b.block_id), title: b.block_name })),
        }
        if (blockId) blockData.block_id = blockId
        if (flatNumber) blockData.flat_number = flatNumber
        responsePayload = {
          screen: "APARTMENT_BLOCK",
          data: blockData,
        }
        console.log("[REG FLOW RESP APT]", JSON.stringify(responsePayload, null, 2))
      }
    }

    // Response must be a raw Base64 encoded encrypted string (NOT JSON wrapper)
    const encrypted = encryptFlowResponse(responsePayload, decryptedAesKey, iv)
    res.set("Content-Type", "text/plain")
    res.send(encrypted)

  } catch (err) {
    console.error("Flow data exchange error:", err.message)
    res.status(500).send("Internal error")
  }
})

module.exports = router
