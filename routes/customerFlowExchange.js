const express  = require("express")
const crypto   = require("crypto")
const fs_      = require("fs")
const path_    = require("path")
const axios    = require("axios")
const pool     = require("../db")
const { generateOrdersForVendor } = require("../services/orderGenerator")
const { getVendorDeliveryPolicy, computeOrderDeliveryCharge } = require("../services/orderPricing")

const router = express.Router()

function getISTDateStr(offsetDays = 0) {
  const now = new Date()
  const istNow = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
  const date = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + offsetDays)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

async function cleanupTodaySubscriptionOrders(customerId, vendorId) {
  const today = getISTDateStr(0)
  await pool.query(`
    DELETE FROM order_items oi
    USING orders o
    WHERE oi.order_id = o.order_id
      AND o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND oi.order_type = 'subscription'
  `, [customerId, vendorId, today])

  await pool.query(`
    DELETE FROM orders o
    WHERE o.customer_id = $1
      AND o.vendor_id = $2
      AND o.order_date = $3::date
      AND o.is_delivered = false
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id = o.order_id
      )
  `, [customerId, vendorId, today])
}

/* ── Private key ── */
let FLOW_PRIVATE_KEY = null
if (process.env.FLOW_PRIVATE_KEY) {
  FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY.replace(/\\n/g, "\n")
} else {
  try {
    FLOW_PRIVATE_KEY = fs_.readFileSync(path_.join(__dirname, "../private.pem"), "utf8")
  } catch {
    console.warn("⚠️  private.pem not found — customer flow decryption will not work")
  }
}

/* ── Decrypt / Encrypt helpers ── */
function decryptFlowRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body
  const decryptedAesKey = crypto.privateDecrypt(
    { key: FLOW_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  )
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
  const flippedIv = Buffer.from(iv.map((b) => ~b & 0xff))
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseData), "utf8"), cipher.final()])
  const tag       = cipher.getAuthTag()
  return Buffer.concat([encrypted, tag]).toString("base64")
}

/* ── IST date helpers ── */
function getISTDate() {
  const now = new Date()
  return new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
}
function istDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/* ── Constants ── */
const MAX_SLOTS = 6
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN

function getMaxQtyLimit(rawValue) {
  const parsed = parseInt(rawValue, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

async function sendWhatsApp(phoneNumberId, payload) {
  if (!phoneNumberId || !WHATSAPP_TOKEN) return
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    )
  } catch (err) {
    console.error("Customer flow WhatsApp send error:", JSON.stringify(err.response?.data || err.message))
  }
}

async function sendText(phoneNumberId, phone, text) {
  await sendWhatsApp(phoneNumberId, {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: text },
  })
}

async function sendButtons(phoneNumberId, phone, body, buttons) {
  await sendWhatsApp(phoneNumberId, {
    messaging_product: "whatsapp",
    to: phone,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  })
}

async function getFlowContext(vendorId, customerId) {
  const [{ rows: vendorRows }, { rows: customerRows }] = await Promise.all([
    pool.query(`SELECT vendor_id, phone_number_id FROM vendors WHERE vendor_id=$1`, [vendorId]),
    pool.query(`SELECT customer_id, phone FROM customers WHERE customer_id=$1`, [customerId]),
  ])
  return {
    vendor: vendorRows[0] || null,
    customer: customerRows[0] || null,
  }
}

async function upsertConversationState(phone, state, vendorId, tempData = {}) {
  if (!phone) return
  await pool.query(`
    INSERT INTO conversation_state(phone, state, selected_vendor_id, temp_data)
    VALUES($1, $2, $3, $4)
    ON CONFLICT(phone) DO UPDATE SET
      state=$2,
      selected_vendor_id=$3,
      temp_data=$4
  `, [phone, state, vendorId, tempData])
}

function readQty(flowData, index) {
  const candidates = [
    flowData?.[`qty_${index}`],
    flowData?.form?.[`qty_${index}`],
    flowData?.data?.[`qty_${index}`],
    flowData?.input?.[`qty_${index}`],
  ]
  return candidates.find((value) => value !== undefined && value !== null)
}

/* ── Build product screen data for INIT response ── */
async function buildProductScreenData(vendorId, customerId, mode = "sub") {
  const orderTypeFilter = mode === "adhoc"
    ? `(order_type='adhoc' OR order_type='both')`
    : `(order_type='subscription' OR order_type='both')`

  const [{ rows: products }, { rows: settingsRows }] = await Promise.all([
    pool.query(
      `SELECT product_id, name, unit, price, delivery_charge
       FROM products WHERE vendor_id=$1 AND is_active=true AND ${orderTypeFilter}
       ORDER BY sort_order, product_id LIMIT $2`,
      [vendorId, MAX_SLOTS]
    ),
    pool.query(
      `SELECT max_quantity_per_order
       FROM vendor_settings
       WHERE vendor_id=$1
       LIMIT 1`,
      [vendorId]
    ),
  ])

  const maxQtyPerOrder = getMaxQtyLimit(settingsRows[0]?.max_quantity_per_order)

  /* Current subscription quantities (for pre-population) */
  let subMap = {}
  if (mode === "sub") {
    const [{ rows: baseSubs }, { rows: subs }] = await Promise.all([
      pool.query(
        `SELECT status
         FROM subscriptions
         WHERE customer_id=$1 AND vendor_id=$2
         LIMIT 1`,
        [customerId, vendorId]
      ),
      pool.query(
        `SELECT product_id, quantity, is_active FROM customer_subscriptions
         WHERE customer_id=$1 AND vendor_id=$2`,
        [customerId, vendorId]
      ),
    ])

    if (baseSubs[0]?.status === "active") {
      subs.forEach(s => { subMap[s.product_id] = s })
    }
  }

  /* Tomorrow's existing adhoc items (for pre-population) */
  let adhocMap = {}
  if (mode === "adhoc") {
    const ist = getISTDate()
    const tom = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate() + 1)
    const tomorrowStr = istDateStr(tom)
    const { rows: adhocItems } = await pool.query(`
      SELECT oi.product_id, oi.quantity
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE o.customer_id=$1 AND o.vendor_id=$2 AND o.order_date=$3 AND oi.order_type='adhoc'
    `, [customerId, vendorId, tomorrowStr])
    adhocItems.forEach(i => { adhocMap[i.product_id] = i.quantity })
  }

  const data = {
    max_qty_note: maxQtyPerOrder
      ? `Only enter packet count like 1, 2, 3. Max ${maxQtyPerOrder}.`
      : "Only enter packet count like 1, 2, 3.",
  }

  for (let i = 1; i <= MAX_SLOTS; i++) {
    const p = products[i - 1]
    if (p) {
      const cs         = subMap[p.product_id]
      const subQty     = (cs && cs.is_active) ? cs.quantity : 0
      const adhocQty   = adhocMap[p.product_id] || 0
      const currentQty = mode === "sub" ? subQty : adhocQty

      const nameWithUnit = p.unit ? `${p.name} (${p.unit})` : p.name
      const price        = parseFloat(p.price).toFixed(2)
      const priceLabel   = `₹${price} per unit`

      data[`product_${i}_name`]  = nameWithUnit.length <= 30 ? nameWithUnit : nameWithUnit.slice(0, 30)
      data[`product_${i}_price`] = `Price: Rs.${price} each`
      data[`product_${i}_label`] = `${nameWithUnit} - Rs.${price} per unit`
      data[`show_product_${i}`]  = true
      data[`qty_${i}_init`]      = currentQty > 0 ? String(currentQty) : ""
    } else {
      data[`product_${i}_name`]  = ""
      data[`product_${i}_price`] = ""
      data[`product_${i}_label`] = ""
      data[`show_product_${i}`]  = false
      data[`qty_${i}_init`]      = ""
    }
  }

  return { data, products }
}

/* ── Main endpoint ── */
router.post("/", async (req, res) => {
  try {
    if (!FLOW_PRIVATE_KEY) {
      return res.status(500).send("Private key not configured")
    }

    let rawBody = req.body
    if (Buffer.isBuffer(rawBody)) rawBody = rawBody.toString("utf8")
    const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody

    const { decryptedAesKey, iv, payload } = decryptFlowRequest(parsed)
    console.log("\n🔓 Customer Flow Decrypted Payload:", JSON.stringify(payload, null, 2))

    const { action, data: flowData, flow_token } = payload

    let responsePayload = {}

    /* ── Health check ── */
    if (action === "ping") {
      responsePayload = { data: { status: "active" } }

    /* ── INIT: send product screen ── */
    } else if (action === "INIT") {
      const parts      = (flow_token || "").split(":")
      const vendorId   = parseInt(parts[0])
      const customerId = parseInt(parts[1])
      const mode       = parts[2] || "sub"

      if (!vendorId || !customerId) {
        responsePayload = { data: { status: "error", message: "Invalid token" } }
      } else {
        const { data } = await buildProductScreenData(vendorId, customerId, mode)
        responsePayload = { screen: mode === "adhoc" ? "PRODUCT_LIST_ADHOC" : "PRODUCT_LIST", data }
      }

    /* ── data_exchange: form submitted ── */
    } else if (action === "data_exchange") {
      const parts      = (flow_token || "").split(":")
      const vendorId   = parseInt(parts[0])
      const customerId = parseInt(parts[1])
      const mode       = parts[2] || "sub"

      console.log(`\n📦 Flow submit — vendor:${vendorId} customer:${customerId} mode:${mode}`)
      console.log("Form data keys:", Object.keys(flowData || {}))
      console.log("Form data:", JSON.stringify(flowData))

      if (!vendorId || !customerId) {
        responsePayload = { screen: "SUCCESS", data: {} }
      } else {
        const orderTypeFilter = mode === "adhoc"
          ? `(order_type='adhoc' OR order_type='both')`
          : `(order_type='subscription' OR order_type='both')`

        const { rows: vendorSettingsRows } = await pool.query(
          `SELECT max_quantity_per_order
           FROM vendor_settings
           WHERE vendor_id=$1
           LIMIT 1`,
          [vendorId]
        )
        const maxQtyPerOrder = getMaxQtyLimit(vendorSettingsRows[0]?.max_quantity_per_order)

        const { rows: products } = await pool.query(
          `SELECT product_id, name, unit, price, delivery_charge
           FROM products WHERE vendor_id=$1 AND is_active=true AND ${orderTypeFilter}
           ORDER BY sort_order, product_id LIMIT $2`,
          [vendorId, MAX_SLOTS]
        )
        console.log(`Products found: ${products.map(p => p.name).join(", ")}`)

        if (mode === "adhoc") {
          /* ── Adhoc: store cart in temp_data for confirmation step ── */
          const cartItems = []
          let hadFlowInput = false
          for (let i = 0; i < products.length; i++) {
            const p   = products[i]
            const raw = readQty(flowData, i + 1)
            if (!raw || String(raw).trim() === "") continue
            hadFlowInput = true
            const qty = parseInt(raw)
            if (isNaN(qty) || qty < 0 || (maxQtyPerOrder && qty > maxQtyPerOrder)) continue
            if (qty === 0) continue
            cartItems.push({
              product_id:   p.product_id,
              product_name: p.name,
              product_unit: p.unit || "",
              price:        parseFloat(p.price),
              qty,
            })
            console.log(`  Adhoc item: ${p.name} × ${qty}`)
          }

          if (true) {
            const policy = await getVendorDeliveryPolicy(vendorId)
            const deliveryCharge = cartItems.length > 0
              ? computeOrderDeliveryCharge(
                  cartItems.map((item) => ({ quantity: item.qty, order_type: "adhoc" })),
                  policy
                )
              : 0
            /* Store cart in customer's conversation_state temp_data */
            await pool.query(`
              UPDATE conversation_state
              SET temp_data = COALESCE(temp_data, '{}'::jsonb) || $1::jsonb
              WHERE phone = (SELECT phone FROM customers WHERE customer_id=$2 LIMIT 1)
            `, [
              JSON.stringify({
                flow_cart: cartItems,
                flow_delivery_charge: deliveryCharge,
                flow_adhoc_submitted: hadFlowInput,
              }),
              customerId,
            ])
            console.log(`Adhoc cart stored (${cartItems.length} items), delivery: ₹${deliveryCharge}`)
          } else {
            console.log("Adhoc: no items entered — nothing stored")
          }

        } else {
          /* ── Subscription: save immediately ── */
          // If customer submitted without touching anything (all empty), treat as "cancel all" — save all as 0
          const allEmpty = products.every((_, i) => {
            const raw = readQty(flowData, i + 1)
            return raw === undefined || raw === null || String(raw).trim() === ""
          })
          if (allEmpty) {
            console.log("Subscription: all fields empty — cancelling all subscriptions")
            for (const p of products) {
              await pool.query(`
                UPDATE customer_subscriptions
                SET is_active=false, quantity=0
                WHERE customer_id=$1 AND vendor_id=$2 AND product_id=$3
              `, [customerId, vendorId, p.product_id])
            }
            await pool.query(`
              INSERT INTO subscriptions (customer_id, vendor_id, quantity, status)
              VALUES ($1,$2,0,'inactive')
              ON CONFLICT (customer_id, vendor_id)
              DO UPDATE SET status='inactive', quantity=0
            `, [customerId, vendorId])
            await cleanupTodaySubscriptionOrders(customerId, vendorId)
            await pool.query(`
              UPDATE conversation_state
              SET temp_data = COALESCE(temp_data, '{}'::jsonb) || '{"flow_sub_saved": true}'::jsonb
              WHERE phone = (SELECT phone FROM customers WHERE customer_id=$1 LIMIT 1)
            `, [customerId])
          }

          let anyChanged = allEmpty
          for (let i = 0; i < (allEmpty ? 0 : products.length); i++) {
            const p   = products[i]
            const raw = readQty(flowData, i + 1)
            if (raw === undefined || raw === null || String(raw).trim() === "") continue
            const qty = parseInt(raw)
            if (isNaN(qty) || qty < 0 || (maxQtyPerOrder && qty > maxQtyPerOrder)) continue

            console.log(`  Sub: ${p.name} qty=${qty}`)
            anyChanged = true

            if (qty === 0) {
              await pool.query(`
                UPDATE customer_subscriptions
                SET is_active=false, quantity=0
                WHERE customer_id=$1 AND vendor_id=$2 AND product_id=$3
              `, [customerId, vendorId, p.product_id])
            } else {
              await pool.query(`
                INSERT INTO customer_subscriptions
                  (customer_id, vendor_id, product_id, quantity, is_active)
                VALUES ($1,$2,$3,$4,true)
                ON CONFLICT (customer_id, product_id)
                DO UPDATE SET quantity=$4, is_active=true, vendor_id=$2
              `, [customerId, vendorId, p.product_id, qty])

            }
          }

          if (anyChanged) {
            const { rows: activeSubRows } = await pool.query(`
              SELECT COALESCE(SUM(quantity), 0) AS total_qty
              FROM customer_subscriptions
              WHERE customer_id=$1 AND vendor_id=$2 AND is_active=true AND quantity > 0
            `, [customerId, vendorId])
            const totalQty = parseInt(activeSubRows[0]?.total_qty || 0, 10) || 0

            await pool.query(`
              INSERT INTO subscriptions (customer_id, vendor_id, quantity, status)
              VALUES ($1,$2,$3,$4)
              ON CONFLICT (customer_id, vendor_id)
              DO UPDATE SET status=$4, quantity=$3
            `, [customerId, vendorId, totalQty, totalQty > 0 ? "active" : "inactive"])

            await cleanupTodaySubscriptionOrders(customerId, vendorId)
            /* Mark as saved so customerBot confirmation message is shown */
            await pool.query(`
              UPDATE conversation_state
              SET temp_data = COALESCE(temp_data, '{}'::jsonb) || '{"flow_sub_saved": true}'::jsonb
              WHERE phone = (SELECT phone FROM customers WHERE customer_id=$1 LIMIT 1)
            `, [customerId])

            try {
              await generateOrdersForVendor(vendorId, { includeToday: false, includeTomorrow: true })
              console.log("Orders regenerated ✅")
            } catch (genErr) {
              console.error("Order regeneration error:", genErr.message)
            }
          }
        }

        responsePayload = {
          screen: "SUCCESS",
          data: { extension_message_response: { params: { flow_token } } }
        }
      }
    }

    const encrypted = encryptFlowResponse(responsePayload, decryptedAesKey, iv)
    res.set("Content-Type", "text/plain")
    res.send(encrypted)

  } catch (err) {
    console.error("Customer flow exchange error:", err.message)
    res.status(500).send("Internal error")
  }
})

module.exports = router
