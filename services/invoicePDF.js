const PDFDocument = require("pdfkit")

/* ── helpers ── */
function dateLabel(val) {
  const fmt = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
  if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
    const [yr, mo, dy] = val.split("-").map(Number)
    return fmt.format(new Date(Date.UTC(yr, mo - 1, dy, 12, 0, 0)))
  }
  const date = val instanceof Date ? val : new Date(val)
  return fmt.format(date)
}

/* ── colours ── */
const NAVY   = "#0f2057"
const BLUE   = "#1a56db"
const GOLD   = "#f59e0b"
const LBLUE  = "#eff6ff"
const LGRAY  = "#f7f8fa"
const ROWALT = "#f8f9ff"
const TEXT   = "#1a1a2e"
const MUTED  = "#6b7280"
const WHITE  = "#ffffff"
const YELLOW = "#fefce8"
const YLINE  = "#fbbf24"

/**
 * Generate bill PDF buffer.
 * @param {object} data  - { customer, orders, price_per_unit, vendor }
 *   orders[].items = [{ product_name, unit, quantity, price_at_order,
 *                       delivery_charge_at_order, order_type }]
 * @param {string} from  - "YYYY-MM-DD"
 * @param {string} to    - "YYYY-MM-DD"
 */
function generateInvoicePDF(data, from, to) {
  return new Promise((resolve, reject) => {
    const { customer, orders, price_per_unit, vendor } = data
    const delivered  = (orders || []).filter(o => o.is_delivered)
    const hasItems   = delivered.some(o => o.items && o.items.length > 0)

    const doc    = new PDFDocument({ margin: 0, size: "A4" })
    const chunks = []
    doc.on("data",  c => chunks.push(c))
    doc.on("end",   () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const W      = doc.page.width   // 595
    const H      = doc.page.height  // 842
    const margin = 42

    const rate = Number(price_per_unit) || 0

    // Compute totals
    let totalAmt = 0
    if (hasItems) {
      for (const o of delivered) {
        const orderDelivery = parseFloat(o.delivery_charge_amount || 0)
          || (o.items || []).reduce((sum, item) => sum + parseFloat(item.delivery_charge_at_order || 0), 0)
        for (const it of (o.items || [])) {
          totalAmt += it.quantity * parseFloat(it.price_at_order)
        }
        totalAmt += orderDelivery
      }
    } else {
      totalAmt = delivered.reduce((s, o) => s + (o.quantity * rate) + parseFloat(o.delivery_charge_amount || 0), 0)
    }

    const billNo  = `BILL-${from.replace(/-/g, "")}-${String(customer.phone).slice(-4)}`
    const bizName = (vendor.business_name || "MilkRoute").trim()
    const bizAddr = [vendor.area, vendor.city].filter(Boolean).join(", ")
    const now = new Date()
    const istNow = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000)
    const today   = dateLabel(`${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, "0")}-${String(istNow.getDate()).padStart(2, "0")}`)

    /* ══ HEADER ══ */
    doc.rect(0, 0, W, 90).fill(NAVY)
    doc.rect(0, 90, W, 6).fill(GOLD)

    const cx = margin + 22, cy = 44
    doc.circle(cx, cy, 22).fill(BLUE)
    doc.fontSize(18).font("Helvetica-Bold").fillColor(WHITE)
    doc.text("M", cx - 6, cy - 10)

    doc.fillColor(WHITE).fontSize(20).font("Helvetica-Bold")
    doc.text(bizName, margin + 52, 24)
    doc.fontSize(9).font("Helvetica").fillColor("#a0b4e0")
    if (bizAddr)               doc.text(bizAddr,                              margin + 52, 48)
    if (vendor.whatsapp_number) doc.text(`WhatsApp: ${vendor.whatsapp_number}`, margin + 52, 60)

    doc.fontSize(26).font("Helvetica-Bold").fillColor(WHITE)
    doc.text("MILK BILL", 0, 22, { width: W - margin, align: "right" })
    doc.fontSize(9).font("Helvetica").fillColor("#a0b4e0")
    doc.text(billNo,           0, 58, { width: W - margin, align: "right" })
    doc.text(`Date: ${today}`, 0, 70, { width: W - margin, align: "right" })

    /* ══ INFO BOXES ══ */
    let y = 112
    const boxH = 68

    doc.roundedRect(margin, y, 236, boxH, 3).fill(LGRAY)
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
    doc.text("BILL TO", margin + 12, y + 9)
    doc.fontSize(12).font("Helvetica-Bold").fillColor(TEXT)
    doc.text(`+${customer.phone}`, margin + 12, y + 21)
    if (customer.address) {
      doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
      doc.text(customer.address, margin + 12, y + 37, { width: 210 })
    }

    doc.roundedRect(margin + 244, y, 166, boxH, 3).fill(LBLUE)
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(BLUE)
    doc.text("BILLING PERIOD", margin + 256, y + 9)
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(dateLabel(from), margin + 256, y + 22)
    doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
    doc.text("to", margin + 256, y + 38)
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(dateLabel(to), margin + 256, y + 50)

    const bnX = margin + 418
    doc.roundedRect(bnX, y, W - margin - bnX, boxH, 3).fill(NAVY)
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#a0b4e0")
    doc.text("BILL NO", bnX + 8, y + 9, { width: W - margin - bnX - 8 })
    doc.fontSize(8).font("Helvetica-Bold").fillColor(GOLD)
    doc.text(billNo, bnX + 8, y + 22, { width: W - margin - bnX - 8 })
    doc.fontSize(7.5).font("Helvetica").fillColor("#a0b4e0")
    doc.text("Generated", bnX + 8, y + 44, { width: W - margin - bnX - 8 })
    doc.fontSize(8).font("Helvetica-Bold").fillColor(WHITE)
    doc.text(today, bnX + 8, y + 55, { width: W - margin - bnX - 8 })

    /* ══ TABLE ══ */
    y += boxH + 20
    const tableW = W - 2 * margin

    if (hasItems) {
      /* ── Multi-product layout ── */
      // Columns: Date | Product | Type | Qty | Price | Del. Charge | Amount
      const cols = [
        { x: margin,       w: 90,  label: "Date",         align: "left"   },
        { x: margin + 90,  w: 130, label: "Product",      align: "left"   },
        { x: margin + 220, w: 50,  label: "Type",         align: "center" },
        { x: margin + 270, w: 40,  label: "Qty",          align: "center" },
        { x: margin + 310, w: 65,  label: "Price",        align: "right"  },
        { x: margin + 375, w: 55,  label: "Del. Charge",  align: "right"  },
        { x: margin + 430, w: tableW - 430, label: "Amount", align: "right" },
      ]

      doc.rect(margin, y, tableW, 24).fill(BLUE)
      doc.fontSize(8.5).font("Helvetica-Bold").fillColor(WHITE)
      cols.forEach(c => doc.text(c.label, c.x + 3, y + 8, { width: c.w - 6, align: c.align }))
      y += 24

      if (delivered.length === 0) {
        doc.rect(margin, y, tableW, 40).fill(ROWALT)
        doc.fontSize(11).font("Helvetica").fillColor(MUTED)
        doc.text("No delivered orders in this period.", margin, y + 13, { width: tableW, align: "center" })
        y += 40
      } else {
        let rowIdx = 0
        for (const o of delivered) {
          const items = o.items || []
          if (items.length === 0) {
            // Legacy order without items — show as single row
            if (y > H - 150) { doc.addPage({ margin: 0, size: "A4" }); y = 40 }
            const rowH = 20
            doc.rect(margin, y, tableW, rowH).fill(rowIdx % 2 === 0 ? WHITE : ROWALT)
            doc.fontSize(8.5).font("Helvetica").fillColor(TEXT)
            doc.text(dateLabel(o.order_date), cols[0].x + 3, y + 5, { width: cols[0].w - 6, align: cols[0].align })
            doc.text("—",                     cols[1].x + 3, y + 5, { width: cols[1].w - 6, align: cols[1].align })
            doc.text("sub",                   cols[2].x + 3, y + 5, { width: cols[2].w - 6, align: cols[2].align })
            doc.text(String(o.quantity),      cols[3].x + 3, y + 5, { width: cols[3].w - 6, align: cols[3].align })
            doc.text(`Rs.${rate.toFixed(2)}`, cols[4].x + 3, y + 5, { width: cols[4].w - 6, align: cols[4].align })
            const orderDelivery = parseFloat(o.delivery_charge_amount || 0)
              || (o.items || []).reduce((sum, item) => sum + parseFloat(item.delivery_charge_at_order || 0), 0)
            doc.text(orderDelivery > 0 ? `Rs.${orderDelivery.toFixed(2)}` : "—", cols[5].x + 3, y + 5, { width: cols[5].w - 6, align: cols[5].align })
            doc.font("Helvetica-Bold")
            doc.text(`Rs.${((o.quantity * rate) + orderDelivery).toFixed(2)}`, cols[6].x + 3, y + 5, { width: cols[6].w - 6, align: cols[6].align })
            y += rowH; rowIdx++
          } else {
            // Show date on first item row, indent subsequent
            const orderDelivery = parseFloat(o.delivery_charge_amount || 0)
              || (o.items || []).reduce((sum, item) => sum + parseFloat(item.delivery_charge_at_order || 0), 0)
            for (let i = 0; i < items.length; i++) {
              if (y > H - 150) { doc.addPage({ margin: 0, size: "A4" }); y = 40 }
              const it   = items[i]
              const rowH = 20
              const bg   = rowIdx % 2 === 0 ? WHITE : ROWALT
              const isAdhoc = it.order_type === "adhoc"
              if (isAdhoc) doc.rect(margin, y, tableW, rowH).fill(YELLOW)
              else         doc.rect(margin, y, tableW, rowH).fill(bg)

              doc.fontSize(8.5).font("Helvetica").fillColor(TEXT)
              // Date only on first item of this order
              if (i === 0) doc.text(dateLabel(o.order_date), cols[0].x + 3, y + 5, { width: cols[0].w - 6 })

              const productLabel = it.product_name + (it.unit ? ` (${it.unit})` : "")
              doc.text(productLabel,            cols[1].x + 3, y + 5, { width: cols[1].w - 6 })

              // Type badge
              doc.fontSize(7).fillColor(isAdhoc ? "#92400e" : BLUE)
              doc.text(isAdhoc ? "Adhoc" : "Sub", cols[2].x + 3, y + 6, { width: cols[2].w - 6, align: "center" })

              doc.fontSize(8.5).fillColor(TEXT)
              doc.text(String(it.quantity),            cols[3].x + 3, y + 5, { width: cols[3].w - 6, align: "center" })
              doc.fillColor(MUTED)
              doc.text(`Rs.${parseFloat(it.price_at_order).toFixed(2)}`, cols[4].x + 3, y + 5, { width: cols[4].w - 6, align: "right" })
              const dc = i === 0 ? orderDelivery : 0
              doc.text(dc > 0 ? `Rs.${dc.toFixed(2)}` : "—", cols[5].x + 3, y + 5, { width: cols[5].w - 6, align: "right" })
              const amt = (it.quantity * parseFloat(it.price_at_order)) + dc
              doc.font("Helvetica-Bold").fillColor(TEXT)
              doc.text(`Rs.${amt.toFixed(2)}`, cols[6].x + 3, y + 5, { width: cols[6].w - 6, align: "right" })
              y += rowH; rowIdx++
            }

            // Date separator line between orders
            doc.rect(margin, y, tableW, 0.5).fill("#e5e7eb")
          }
        }
      }

    } else {
      /* ── Legacy layout (no items) ── */
      const cols = [
        { x: margin,       w: 26,  label: "#",             align: "center" },
        { x: margin + 26,  w: 165, label: "Delivery Date", align: "left"   },
        { x: margin + 191, w: 80,  label: "Packets",       align: "center" },
        { x: margin + 271, w: 120, label: "Rate / Packet", align: "right"  },
        { x: margin + 391, w: tableW - 391, label: "Amount", align: "right" },
      ]
      doc.rect(margin, y, tableW, 24).fill(BLUE)
      doc.fontSize(9.5).font("Helvetica-Bold").fillColor(WHITE)
      cols.forEach(c => doc.text(c.label, c.x + 4, y + 7, { width: c.w - 8, align: c.align }))
      y += 24

      if (delivered.length === 0) {
        doc.rect(margin, y, tableW, 40).fill(ROWALT)
        doc.fontSize(11).font("Helvetica").fillColor(MUTED)
        doc.text("No delivered orders in this period.", margin, y + 13, { width: tableW, align: "center" })
        y += 40
      } else {
        delivered.forEach((o, i) => {
          if (y > H - 150) { doc.addPage({ margin: 0, size: "A4" }); y = 40 }
          const rowH = 22
          doc.rect(margin, y, tableW, rowH).fill(i % 2 === 0 ? WHITE : ROWALT)
          doc.fontSize(9.5).font("Helvetica").fillColor(TEXT)
          doc.text(String(i + 1),           cols[0].x + 4, y + 6, { width: cols[0].w - 8, align: cols[0].align })
          doc.text(dateLabel(o.order_date), cols[1].x + 4, y + 6, { width: cols[1].w - 8, align: cols[1].align })
          doc.text(String(o.quantity),      cols[2].x + 4, y + 6, { width: cols[2].w - 8, align: cols[2].align })
          doc.fillColor(MUTED)
          doc.text(`Rs. ${rate.toFixed(2)}`,                cols[3].x + 4, y + 6, { width: cols[3].w - 8, align: cols[3].align })
          doc.font("Helvetica-Bold").fillColor(TEXT)
          const orderDelivery = parseFloat(o.delivery_charge_amount || 0)
            || (o.items || []).reduce((sum, item) => sum + parseFloat(item.delivery_charge_at_order || 0), 0)
          doc.text(`Rs. ${((o.quantity * rate) + orderDelivery).toFixed(2)}`, cols[4].x + 4, y + 6, { width: cols[4].w - 8, align: cols[4].align })
          y += rowH
        })
      }
    }

    /* ══ TOTALS ══ */
    doc.rect(margin, y + 4, tableW, 0.5).fill(BLUE)
    y += 16

    const tW = 200, tH = 56
    const tX = W - margin - tW
    doc.roundedRect(tX, y, tW, tH, 3).fill(LBLUE)
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text("Total Amount:", tX + 10, y + 14, { width: tW - 20 })
    doc.fontSize(13).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(`Rs. ${totalAmt.toFixed(2)}`, tX + 10, y + 14, { width: tW - 20, align: "right" })
    doc.fontSize(8).font("Helvetica-Oblique").fillColor(MUTED)
    doc.text("* Only delivered orders are billed.", tX + 10, y + 36, { width: tW - 20 })

    doc.fontSize(8.5).font("Helvetica-Oblique").fillColor(MUTED)
    doc.text("Thank you for your continued support!", margin, y + 18, { width: tX - margin - 14 })

    /* ══ FOOTER ══ */
    const footerY = H - 32
    doc.rect(0, footerY - 6, W, 38).fill(NAVY)
    doc.rect(0, footerY - 6, W, 3).fill(GOLD)
    doc.fontSize(8).font("Helvetica").fillColor("#a0b4e0")
    doc.text(bizName,                  margin, footerY + 6, { width: 180 })
    doc.text("Generated by MilkRoute", 0,      footerY + 6, { width: W,          align: "center" })
    doc.text(`Bill No: ${billNo}`,      0,      footerY + 6, { width: W - margin, align: "right"  })

    doc.end()
  })
}

module.exports = { generateInvoicePDF }
