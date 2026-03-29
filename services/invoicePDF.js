const PDFDocument = require("pdfkit")

/* ── helpers ── */
function dateLabel(val) {
  const iso = val instanceof Date ? val.toISOString() : String(val)
  const [yr, mo, dy] = iso.slice(0, 10).split("-").map(Number)
  return new Date(yr, mo - 1, dy).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric"
  })
}

/* ── colours ── */
const NAVY   = "#0f2057"
const BLUE   = "#1a56db"
const GOLD   = "#f59e0b"
const LBLUE  = "#eff6ff"   // billing period box bg
const LGRAY  = "#f7f8fa"   // bill-to box bg
const ROWALT = "#f8f9ff"   // alternate table row
const TEXT   = "#1a1a2e"
const MUTED  = "#6b7280"
const WHITE  = "#ffffff"

/**
 * Generate bill PDF buffer.
 * @param {object} data  - { customer, orders, price_per_unit, vendor }
 * @param {string} from  - "YYYY-MM-DD"
 * @param {string} to    - "YYYY-MM-DD"
 * @returns {Promise<Buffer>}
 */
function generateInvoicePDF(data, from, to) {
  return new Promise((resolve, reject) => {
    const { customer, orders, price_per_unit, vendor } = data
    const delivered = (orders || []).filter(o => o.is_delivered)

    const doc    = new PDFDocument({ margin: 0, size: "A4" })
    const chunks = []
    doc.on("data",  c => chunks.push(c))
    doc.on("end",   () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const W      = doc.page.width   // 595
    const H      = doc.page.height  // 842
    const margin = 42

    const rate     = Number(price_per_unit) || 0
    const totalQty = delivered.reduce((s, o) => s + o.quantity, 0)
    const totalAmt = delivered.reduce((s, o) => s + o.quantity * rate, 0)
    const billNo   = `BILL-${from.replace(/-/g, "")}-${String(customer.phone).slice(-4)}`
    const bizName  = (vendor.business_name || "MilkRoute").trim()
    const bizAddr  = [vendor.area, vendor.city].filter(Boolean).join(", ")
    const today    = dateLabel(new Date().toISOString().slice(0, 10))

    /* ══════════════════════════════════════════
       HEADER BAND  (navy + gold stripe)
    ══════════════════════════════════════════ */
    doc.rect(0, 0, W, 90).fill(NAVY)
    doc.rect(0, 90, W, 6).fill(GOLD)

    // Logo circle
    const cx = margin + 22, cy = 44
    doc.circle(cx, cy, 22).fill(BLUE)
    doc.fontSize(18).font("Helvetica-Bold").fillColor(WHITE)
    doc.text("M", cx - 6, cy - 10)

    // Business name / details
    doc.fillColor(WHITE).fontSize(20).font("Helvetica-Bold")
    doc.text(bizName, margin + 52, 24)
    doc.fontSize(9).font("Helvetica").fillColor("#a0b4e0")
    if (bizAddr)                    doc.text(bizAddr,                          margin + 52, 48)
    if (vendor.whatsapp_number)     doc.text(`WhatsApp: ${vendor.whatsapp_number}`, margin + 52, 60)

    // Right: title + meta
    doc.fontSize(26).font("Helvetica-Bold").fillColor(WHITE)
    doc.text("MILK BILL", 0, 22, { width: W - margin, align: "right" })
    doc.fontSize(9).font("Helvetica").fillColor("#a0b4e0")
    doc.text(billNo,            0, 58, { width: W - margin, align: "right" })
    doc.text(`Date: ${today}`,  0, 70, { width: W - margin, align: "right" })

    /* ══════════════════════════════════════════
       INFO BOXES  (original style)
    ══════════════════════════════════════════ */
    let y = 112
    const boxH = 68

    // Bill To — light gray
    doc.roundedRect(margin, y, 236, boxH, 3).fill(LGRAY)
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(MUTED)
    doc.text("BILL TO", margin + 12, y + 9)
    doc.fontSize(12).font("Helvetica-Bold").fillColor(TEXT)
    doc.text(`+${customer.phone}`, margin + 12, y + 21)
    if (customer.address) {
      doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
      doc.text(customer.address, margin + 12, y + 37, { width: 210 })
    }

    // Billing Period — light blue
    doc.roundedRect(margin + 244, y, 166, boxH, 3).fill(LBLUE)
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(BLUE)
    doc.text("BILLING PERIOD", margin + 256, y + 9)
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(dateLabel(from), margin + 256, y + 22)
    doc.fontSize(8.5).font("Helvetica").fillColor(MUTED)
    doc.text("to", margin + 256, y + 38)
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(dateLabel(to), margin + 256, y + 50)

    // Bill No box — navy
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

    /* ══════════════════════════════════════════
       TABLE
    ══════════════════════════════════════════ */
    y += boxH + 20
    const tableW = W - 2 * margin

    const cols = [
      { x: margin,       w: 26,  label: "#",             align: "center" },
      { x: margin + 26,  w: 165, label: "Delivery Date", align: "left"   },
      { x: margin + 191, w: 80,  label: "Packets",       align: "center" },
      { x: margin + 271, w: 120, label: "Rate / Packet", align: "right"  },
      { x: margin + 391, w: tableW - 391, label: "Amount", align: "right" },
    ]

    // Header
    doc.rect(margin, y, tableW, 24).fill(BLUE)
    doc.fontSize(9.5).font("Helvetica-Bold").fillColor(WHITE)
    cols.forEach(c => {
      doc.text(c.label, c.x + 4, y + 7, { width: c.w - 8, align: c.align })
    })
    y += 24

    if (delivered.length === 0) {
      doc.rect(margin, y, tableW, 40).fill(ROWALT)
      doc.fontSize(11).font("Helvetica").fillColor(MUTED)
      doc.text("No delivered orders in this period.", margin, y + 13, { width: tableW, align: "center" })
      y += 40
    } else {
      delivered.forEach((o, i) => {
        if (y > H - 150) {
          doc.addPage({ margin: 0, size: "A4" })
          y = 40
        }
        const rowH = 22
        doc.rect(margin, y, tableW, rowH).fill(i % 2 === 0 ? WHITE : ROWALT)

        doc.fontSize(9.5).font("Helvetica").fillColor(TEXT)
        doc.text(String(i + 1),           cols[0].x + 4, y + 6, { width: cols[0].w - 8, align: cols[0].align })
        doc.text(dateLabel(o.order_date), cols[1].x + 4, y + 6, { width: cols[1].w - 8, align: cols[1].align })
        doc.text(String(o.quantity),      cols[2].x + 4, y + 6, { width: cols[2].w - 8, align: cols[2].align })
        doc.fillColor(MUTED)
        doc.text(`Rs. ${rate.toFixed(2)}`,                  cols[3].x + 4, y + 6, { width: cols[3].w - 8, align: cols[3].align })
        doc.font("Helvetica-Bold").fillColor(TEXT)
        doc.text(`Rs. ${(o.quantity * rate).toFixed(2)}`,   cols[4].x + 4, y + 6, { width: cols[4].w - 8, align: cols[4].align })
        y += rowH
      })
    }

    /* ══════════════════════════════════════════
       TOTALS  (original style — small box top-right)
    ══════════════════════════════════════════ */
    // Divider line
    doc.rect(margin, y + 4, tableW, 0.5).fill(BLUE)
    y += 16

    // Small totals box — light blue, top-right
    const tW = 200, tH = 74
    const tX = W - margin - tW
    doc.roundedRect(tX, y, tW, tH, 3).fill(LBLUE)

    doc.fontSize(9).font("Helvetica").fillColor(MUTED)
    doc.text("Total Packets Delivered:", tX + 10, y + 12, { width: tW - 20 })
    doc.text("Rate per Packet:",         tX + 10, y + 28, { width: tW - 20 })
    doc.fontSize(11).font("Helvetica-Bold").fillColor(BLUE)
    doc.text("Total Amount:",            tX + 10, y + 50, { width: tW - 20 })

    doc.fontSize(9).font("Helvetica-Bold").fillColor(TEXT)
    doc.text(String(totalQty),           tX + 10, y + 12, { width: tW - 20, align: "right" })
    doc.text(`Rs. ${rate.toFixed(2)}`,   tX + 10, y + 28, { width: tW - 20, align: "right" })
    doc.fontSize(12).font("Helvetica-Bold").fillColor(BLUE)
    doc.text(`Rs. ${totalAmt.toFixed(2)}`, tX + 10, y + 50, { width: tW - 20, align: "right" })

    // Notes — left of totals box
    doc.fontSize(8.5).font("Helvetica-Oblique").fillColor(MUTED)
    doc.text("Thank you for your continued support!",                  margin, y + 18, { width: tX - margin - 14 })
    doc.text("* Only delivered packets are billed.",                   margin, y + 32, { width: tX - margin - 14 })

    /* ══════════════════════════════════════════
       FOOTER  (navy + gold stripe)
    ══════════════════════════════════════════ */
    const footerY = H - 32
    doc.rect(0, footerY - 6, W, 38).fill(NAVY)
    doc.rect(0, footerY - 6, W, 3).fill(GOLD)

    doc.fontSize(8).font("Helvetica").fillColor("#a0b4e0")
    doc.text(bizName,                    margin, footerY + 6, { width: 180 })
    doc.text("Generated by MilkRoute",   0,      footerY + 6, { width: W,          align: "center" })
    doc.text(`Bill No: ${billNo}`,        0,      footerY + 6, { width: W - margin, align: "right"  })

    doc.end()
  })
}

module.exports = { generateInvoicePDF }
