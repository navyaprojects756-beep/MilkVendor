# MilkWhatsAppBot — Full Requirements Document

> **Last updated:** 2026-04-02  
> **Purpose:** Single source of truth for all functional and technical requirements.  
> Update this file whenever a feature is added, changed, or removed.

---

## 1. Project Overview

A WhatsApp-based milk subscription management system with two parts:

| Part | Technology | Purpose |
|------|-----------|---------|
| **Backend Bot** | Node.js + Express + PostgreSQL | Handles WhatsApp webhooks, customer conversations, order generation, billing |
| **Vendor Dashboard** | React (Vite) SPA | Admin UI for vendors to manage customers, orders, products, billing |

The system supports **multiple vendors**, each with their own WhatsApp phone number, customers, products, and subscriptions. A vendor accesses the dashboard via a time-limited JWT link (2 hours expiry) sent through WhatsApp.

---

## 2. Tech Stack

### Backend (`e:/Navya Projects/MilkWhatsAppBot/`)
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (via `pg` pool)
- **WhatsApp API:** Meta Cloud API (Graph API v18.0)
- **Auth:** JWT (`jsonwebtoken`) — vendor dashboard tokens
- **PDF:** PDFKit (`pdfkit`)
- **File uploads:** Multer
- **Encryption:** Node.js built-in `crypto` (AES-128-GCM + RSA OAEP SHA-256) — for WhatsApp Flows
- **Deployment target:** Railway (with environment variables)

### Frontend (`e:/Navya Projects/vendor-dashboard/`)
- **Framework:** React + Vite
- **Styling:** Tailwind CSS
- **Routing:** React Router
- **HTTP:** fetch API (no Axios)
- **Port (local):** 5173

---

## 3. Database Schema (Key Tables)

| Table | Key Columns | Notes |
|-------|------------|-------|
| `vendors` | `vendor_id`, `business_name`, `phone_number_id`, `whatsapp_number`, `area`, `city`, `logo_url`, `order_window_start`, `order_window_end` | One row per WhatsApp phone number |
| `customers` | `customer_id`, `vendor_id`, `phone`, `name`, `address`, `state` | `state` = current bot conversation state |
| `subscriptions` | `subscription_id`, `customer_id`, `vendor_id`, `status` (`active`/`paused`/`cancelled`) | One subscription per customer-vendor pair |
| `customer_subscriptions` | `customer_id`, `vendor_id`, `product_id`, `quantity`, `is_active` | Per-product subscription lines |
| `products` | `product_id`, `vendor_id`, `name`, `unit`, `price`, `delivery_charge`, `is_active` | Products offered by vendor |
| `orders` | `order_id`, `customer_id`, `vendor_id`, `order_date`, `quantity`, `is_delivered`, `payment_status` | One order per customer per date |
| `order_items` | `item_id`, `order_id`, `product_id`, `quantity`, `price_at_order`, `delivery_charge_at_order`, `order_type` (`subscription`/`adhoc`) | Per-product line within an order |
| `subscription_pauses` | `customer_id`, `vendor_id`, `pause_from`, `pause_until` | Date ranges when delivery is paused |
| `apartments` | `apartment_id`, `vendor_id`, `name` | Apartment complexes managed by vendor |
| `blocks` | `block_id`, `apartment_id`, `name` | Blocks/towers within apartments |
| `payments` | `payment_id`, `customer_id`, `vendor_id`, `amount`, `payment_date`, `screenshot_url`, `notes` | Payment records |
| `messages` | `message_id`, `customer_id`, `vendor_id`, `direction` (`inbound`/`outbound`), `content`, `created_at` | Inbox for non-order messages |

---

## 4. Backend — Bot (`bots/customerBot.js`)

### 4.1 Webhook Entry Point

- **Endpoint:** `POST /webhook`
- Receives all WhatsApp messages for all registered vendors
- Routes each message to the correct vendor by matching `entry[0].changes[0].value.metadata.phone_number_id` against the `vendors` table
- Ignores status update webhooks (only process `messages` entries)

### 4.2 New Customer Registration (WhatsApp Flow)

**Trigger:** Customer sends any message (e.g., "Hi") and has no name/address on file.

**Flow:**
1. Bot sends a **WhatsApp Flow** registration template (`customer_registration`) using Meta's template + flow button
2. `flow_token` = `vendorId` (used by backend to load correct apartments)
3. Customer fills a multi-screen form:
   - **WELCOME screen:** Enter name
   - **APARTMENT_ADDRESS screen:** Choose address type (Apartment / House), apartment dropdown (dynamic from DB)
   - **APARTMENT_BLOCK screen:** (if Apartment) Choose block/tower
   - **HOUSE_ADDRESS screen:** (if House) Enter manual address text
4. On form submission (`nfm_reply` webhook message), backend:
   - Updates `customers.name`
   - Saves apartment/block or manual address
   - Sends confirmation text + main menu

**State:** `awaiting_registration` — bot ignores other messages until flow completes.

**Environment variable:** `REGISTRATION_FLOW_ID` — Flow ID from Meta WhatsApp Manager.

**Template name:** `customer_registration` (must be approved by Meta).

### 4.3 Conversation States

| State | Meaning | Next action |
|-------|---------|------------|
| `null` / fresh | New message received | Send registration flow or main menu |
| `awaiting_registration` | Flow sent, waiting for form | Handle `nfm_reply` |
| `menu` | Main menu shown | Route based on selection |
| `adhoc_select_product` | Selecting product for adhoc order | Show product list |
| `adhoc_confirm` | Confirming adhoc order details | Confirm/cancel |
| `pause_select` | Selecting pause type | Date entry |
| `pause_from` | Entering pause start date | Validate and save |
| `pause_until` | Entering pause end date | Save pause |
| `invoice_period` | Entered bill date range | Generate and send invoice |
| `payment_amount` | Entering payment amount | Record payment |

### 4.4 Main Menu Options

Shown as an interactive list. Options:
1. **My Subscription** — view current subscription details
2. **Pause Delivery** — pause for date range
3. **Resume Delivery** — resume paused subscription
4. **Adhoc Order** — order extra product for one day
5. **Generate Bill** — get invoice for a date range
6. **Make Payment** — record payment with optional screenshot

### 4.5 Order Window (Time Gate)

- Vendor has `order_window_start` and `order_window_end` times in the DB
- Orders / pauses / adhoc requests only accepted within this window
- Messages received outside window: save to `messages` inbox + auto-reply with window hours

### 4.6 Unrecognized Messages (Menu State)

- If customer sends text not matching any menu option while in `menu` state:
  - Save message to `messages` inbox (`saveInboundMessage`)
  - Send auto-reply: "Vendor will check your message shortly. For menu options, reply with 1-6."

### 4.7 Invoice / Bill (WhatsApp)

**Trigger:** Customer selects "Generate Bill", enters date range as `DD/MM/YYYY - DD/MM/YYYY`

**Calculation:**
- Queries `orders` joined with `order_items` for the period
- If `order_items` exist: total = `SUM(quantity × (price_at_order + delivery_charge_at_order))`
- Legacy (no items): total = `SUM(quantity × price_per_unit)` from subscription

**WhatsApp text message format:**
```
📋 Your Milk Bill

Period: DD Mon YYYY – DD Mon YYYY
Total Amount: ₹XXX.XX
Amount Due: ₹XXX.XX (after payments)

For full details, check the PDF.
```
- No packet count, rate, or per-delivery breakdown in the text message

**PDF:** Sent as document attachment after the text message.

### 4.8 Adhoc Orders

- Customer selects product from vendor's active product list
- Enters quantity
- Confirms → creates an `order` + `order_item` with `order_type = 'adhoc'`
- Only allowed within order window

### 4.9 Payment Recording

- Customer enters amount
- Optional: sends payment screenshot image (uploaded and saved)
- Saves to `payments` table

---

## 5. Backend — WhatsApp Flow Endpoint

### 5.1 Encryption

WhatsApp Flows use end-to-end encryption:
- **RSA OAEP (SHA-256):** Meta encrypts the AES key using the vendor's public key
- **AES-128-GCM:** Actual request payload encrypted with the AES key
- **Response:** Backend re-encrypts response with same AES key (flipped IV) and returns raw Base64 string

**Key management:**
- Local dev: `private.pem` file in project root (in `.gitignore`)
- Railway/production: `FLOW_PRIVATE_KEY` environment variable (newlines as `\n` literal)
- Public key uploaded to Meta per phone number using `uploadPublicKey.js`

### 5.2 Endpoint

- **Route:** `POST /vendor/whatsapp-flow-data`
- **Middleware:** `express.raw({ type: "*/*" })` must run BEFORE `express.json()` (set up in `server.js`)
- **Response:** `Content-Type: text/plain`, body = raw Base64 encrypted string

### 5.3 Screens

| Action | Input | Response |
|--------|-------|----------|
| `ping` | Health check | `{ status: "active" }` |
| `INIT` / `WELCOME` | First open | Return APARTMENT_ADDRESS screen + apartment list from DB |
| `APARTMENT_ADDRESS` | User picked apartment | Return APARTMENT_BLOCK screen + blocks for that apartment |
| Complete form | `nfm_reply` in webhook | Processed in `customerBot.js` |

### 5.4 Multi-Vendor Support

- One Flow shared across all vendors
- `flow_token` = vendorId — used by endpoint to query correct vendor's apartments
- No separate flow per vendor needed

---

## 6. Backend — Vendor Dashboard API (`routes/vendorDashboard.js`)

All endpoints require `?token=JWT` query parameter. Token verified via `verifyVendorToken()`.

### 6.1 Auth

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/vendor-link` | POST | Main vendor sends WhatsApp number → receives dashboard link via WhatsApp |
| `/auth/login` | POST | (internal) validates JWT |

Token payload: `{ vendorId, role }` — role is `admin` or `viewer`.

**`requireAdmin` middleware:** blocks non-admin tokens from write operations.

### 6.2 Orders

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /orders` | GET | List orders for vendor, with embedded `items` array per order |
| `POST /orders/generate` | POST | Generate orders for today + tomorrow (calls `orderGenerator`) |
| `PATCH /orders/:id/delivered` | PATCH | Mark order as delivered |
| `PATCH /orders/:id/payment` | PATCH | Update payment status |

**Orders response includes embedded items:**
```json
{
  "order_id": 1,
  "order_date": "2026-04-02",
  "quantity": 2,
  "is_delivered": false,
  "items": [
    { "product_name": "Milk", "unit": "L", "quantity": 1, "price_at_order": 40, "delivery_charge_at_order": 5, "order_type": "subscription" },
    { "product_name": "Paneer", "unit": "kg", "quantity": 1, "price_at_order": 300, "delivery_charge_at_order": 0, "order_type": "adhoc" }
  ]
}
```

### 6.3 Customers

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /customers` | GET | List all customers with subscription status |
| `POST /customers` | POST | Add new customer manually |
| `PUT /customers/:id` | PUT | Update customer details |
| `DELETE /customers/:id` | DELETE | Remove customer |
| `GET /customers/:id/invoice` | GET | JSON invoice data with embedded order items |
| `GET /customers/:id/invoice/pdf` | GET | PDF invoice (returns buffer) |

### 6.4 Products

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /products` | GET | List vendor's products |
| `POST /products` | POST | Add product |
| `PUT /products/:id` | PUT | Update product (name, price, delivery_charge, unit) |
| `DELETE /products/:id` | DELETE | Deactivate product |

### 6.5 Subscriptions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /customers/:id/subscription` | GET | Get customer's subscription and product lines |
| `PUT /customers/:id/subscription` | PUT | Update subscription lines |

### 6.6 Pauses

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /pauses` | GET | All active pauses for vendor |
| `POST /pauses` | POST | Add pause for customer |
| `DELETE /pauses/:id` | DELETE | Remove pause |

### 6.7 Apartments & Blocks

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /apartments` | GET | List vendor's apartments |
| `POST /apartments` | POST | Add apartment |
| `PUT /apartments/:id` | PUT | Rename apartment |
| `DELETE /apartments/:id` | DELETE | Remove apartment |
| `GET /apartments/:id/blocks` | GET | List blocks in apartment |
| `POST /apartments/:id/blocks` | POST | Add block |
| `PUT /blocks/:id` | PUT | Rename block |
| `DELETE /blocks/:id` | DELETE | Remove block |

### 6.8 Payments

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /payments` | GET | List payments for vendor |
| `POST /payments` | POST | Add payment (with optional screenshot upload) |
| `DELETE /payments/:id` | DELETE | Remove payment |

### 6.9 Messages Inbox

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /messages` | GET | List inbound messages (non-order) |
| `DELETE /messages/:id` | DELETE | Clear message |

**Messages are saved when:**
1. Customer sends unrecognized input in `menu` state
2. Customer sends message outside order window

### 6.10 Settings

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /settings` | GET | Get vendor settings (order window, business info) |
| `PUT /settings` | PUT | Update settings |
| `POST /upload-logo` | POST | Upload vendor logo (admin only) |

### 6.11 Security Headers

All `/vendor` routes set:
```
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
```
This prevents mobile network carriers/proxies from caching 304 responses.

---

## 7. Order Generation Service (`services/orderGenerator.js`)

Called via `POST /orders/generate` or scheduled.

**Steps:**
1. For each target date (today + tomorrow):
   a. Query active `customer_subscriptions` for vendor
   b. Skip customers with active pause on that date
   c. `INSERT INTO orders ... ON CONFLICT DO UPDATE` (won't overwrite delivered orders)
   d. `INSERT INTO order_items` per product subscription line — snapshots `price` and `delivery_charge` at time of generation

**Price snapshot:** `price_at_order` and `delivery_charge_at_order` capture the price at the time the order was generated, so historical bills are correct even if prices change later.

---

## 8. PDF Invoice Service (`services/invoicePDF.js`)

Generates a professional A4 PDF using PDFKit.

### 8.1 Design
- Navy (`#0f2057`) + gold (`#f59e0b`) header bar
- Business name, logo area (M circle), address, WhatsApp number
- Three info boxes: Bill To (customer phone + address), Billing Period (from–to dates), Bill No
- Data table (multi-product or legacy)
- Total amount box (blue)
- Footer: business name + "Generated by MilkRoute" + bill number

### 8.2 Multi-Product Table (if `order_items` present)

Columns: **Date | Product (unit) | Type | Qty | Price | Del. Charge | Amount**

- Adhoc rows highlighted yellow (`#fefce8`)
- Subscription rows alternating white/light blue
- Date shown only on first item row per order
- Separator line between different dates
- Falls back to legacy row if an order has no items

### 8.3 Legacy Table (no `order_items`)

Columns: **# | Delivery Date | Packets | Rate / Packet | Amount**

### 8.4 Total Calculation
- Multi-product: `SUM(quantity × (price_at_order + delivery_charge_at_order))`
- Legacy: `SUM(quantity × price_per_unit)`
- Only **delivered** orders included

### 8.5 Bill Number Format
`BILL-YYYYMMDD-{last 4 digits of phone}`

---

## 9. Frontend — Vendor Dashboard (`vendor-dashboard/src/`)

### 9.1 Access Flow
1. Vendor sends their number via WhatsApp → receives secure link
2. Link contains JWT token as query param (`?token=xxx`)
3. All API calls include `?token=xxx`
4. Token expires in 2 hours

### 9.2 Pages

#### Orders (`pages/Orders.jsx`)

**Features:**
- Date filter (default: today)
- **Generate Orders button:** Calls `POST /orders/generate`, then re-fetches orders in-place (no page reload)
- **Product Totals tiles:** Aggregated per-product totals across filtered orders
  - Shows: product name, subscription qty, adhoc qty, total qty
  - Computed client-side from `order.items`
- Order cards per customer:
  - Customer name + phone
  - If `items` present: per-product rows with blue (subscription) / yellow (adhoc) color coding
  - If no items: legacy Qty chip
  - Mark Delivered button
  - Payment status badge

#### Customers (`pages/Customers.jsx`)

**Features:**
- Customer list with search
- Add / Edit customer
- View subscription details
- **Bill Dialog:**
  - Date range picker
  - Multi-product table: Date | Product | Type | Qty | Price | Del. | Amount
  - Legacy table if no items: Date | Qty | Rate | Amount
  - Summary chips: deliveries count, total, amount due (red if outstanding) or "Fully Paid ✓"
  - Correct totals from `price_at_order + delivery_charge_at_order`
  - Adhoc rows highlighted yellow
  - Download PDF button → calls `/customers/:id/invoice/pdf`

#### Products (`pages/Products.jsx`)

- List vendor's products with price and delivery charge
- Add / Edit / Delete product
- Unit field (e.g., "L", "kg", "pkt")

#### Apartments (`pages/Apartments.jsx`)

- List apartments and their blocks
- Add / Rename / Delete apartments
- Add / Rename / Delete blocks
- These feed the WhatsApp Flow registration dropdown

#### Blocks (`pages/Blocks.jsx`)

- Standalone blocks management (alternative view)

#### Pauses (`pages/Pauses.jsx`)

- List all active pauses with customer name, date range
- Add pause (select customer + date range)
- Remove pause

#### Messages (`pages/Messages.jsx`)

- Inbox of non-order messages sent by customers
- Includes: timestamp, customer name, message text
- Shows messages from both inside and outside order window
- Delete message option

#### Settings (`pages/Settings.jsx`)

- Order window start / end times
- Business name, area, city
- WhatsApp number display
- Logo upload (admin only, max 5 MB image)

### 9.3 Layout

- **Header (`layout/Header.jsx`):** Business name, logo, current vendor info
- **Sidebar (`layout/Sidebar.jsx`):** Navigation links to all pages
- **Toast (`components/Toast.jsx`):** Success/error notifications

---

## 10. Server Entry Point (`server.js`)

```
app.use("/vendor/whatsapp-flow-data", express.raw({ type: "*/*" }))  ← MUST be before express.json()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use("/webhook", webhookRouter)
app.use("/vendor", vendorDashboardRouter)
app.use(express.static("public"))
```

**Port:** `process.env.PORT || 3000`

---

## 11. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default 3000) |
| `VERIFY_TOKEN` | Yes | WhatsApp webhook verification token |
| `WHATSAPP_TOKEN` | Yes | Meta Cloud API bearer token |
| `MAIN_VENDOR_PHONE_NUMBER_ID` | Yes | Primary vendor's phone number ID |
| `JWT_SECRET` | Yes | Secret for signing vendor dashboard tokens |
| `REGISTRATION_FLOW_ID` | Yes | WhatsApp Flow ID for customer registration |
| `APP_BASE_URL` | Yes | Frontend URL (e.g. `http://localhost:5173/`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Yes | DB credentials |
| `CORS_ORIGIN` | Yes | Frontend origin for CORS |
| `FLOW_PRIVATE_KEY` | Railway only | RSA private key as string (newlines as `\n`) |
| `NODE_ENV` | No | `development` or `production` |

---

## 12. Security

| Concern | Implementation |
|---------|---------------|
| Dashboard auth | JWT with 2h expiry; `requireAdmin` middleware for write ops |
| WhatsApp Flow data | AES-128-GCM + RSA OAEP end-to-end encryption |
| Private key (local) | `private.pem` in `.gitignore` — never committed |
| Private key (Railway) | `FLOW_PRIVATE_KEY` env variable |
| `.env` file | In `.gitignore` — never committed |
| File uploads | MIME type whitelist (images only), 5–10 MB size limit |
| SQL injection | All queries use parameterized `$1, $2` placeholders |
| CORS | Restricted to `CORS_ORIGIN` env value |

---

## 13. File Structure (Relevant Files Only)

```
MilkWhatsAppBot/
├── server.js                        # Express app entry point
├── db.js                            # PostgreSQL pool
├── .env                             # Local secrets (gitignored)
├── .gitignore
├── private.pem                      # RSA private key (gitignored)
├── public.pem                       # RSA public key (gitignored)
├── generateKeys.js                  # One-time RSA key generation (gitignored)
├── uploadPublicKey.js               # One-time public key upload to Meta (gitignored)
├── bots/
│   └── customerBot.js               # WhatsApp message handler (all conversation logic)
├── routes/
│   └── vendorDashboard.js           # All vendor dashboard API endpoints + Flow endpoint
├── services/
│   ├── orderGenerator.js            # Order + order_items generation logic
│   ├── invoicePDF.js                # PDF generation with PDFKit
│   ├── vendorAuth.js                # JWT sign/verify helpers
│   └── whatsappService.js           # (if exists) WhatsApp API helpers
└── public/
    └── uploads/
        ├── images/logo/             # Vendor logo files
        └── payments/                # Payment screenshot files

vendor-dashboard/src/
├── App.jsx                          # Router setup
├── main.jsx                         # Vite entry
├── dashboard/
│   ├── layout/
│   │   ├── Header.jsx
│   │   └── Sidebar.jsx
│   └── pages/
│       ├── Orders.jsx               # Orders list + generate + product tiles
│       ├── Customers.jsx            # Customer list + bill dialog
│       ├── Products.jsx
│       ├── Apartments.jsx
│       ├── Blocks.jsx
│       ├── Pauses.jsx
│       ├── Messages.jsx             # Inbox
│       └── Settings.jsx
└── components/
    └── Toast.jsx
```

---

## 14. Known Pending Items

| Item | Status | Notes |
|------|--------|-------|
| `customer_registration` template | Awaiting Meta approval (24–48 hrs) | Template submitted; once approved, test the flow end-to-end |
| `REGISTRATION_FLOW_ID` in `.env` | Placeholder `YOUR_FLOW_ID_HERE` | Update after Meta approves the flow |
| New vendor onboarding | Manual | When adding a new vendor: add to DB, run `uploadPublicKey.js` with their `phone_number_id`, add phone number to Meta webhook subscriptions |
| Delivery receipt / signature | Not implemented | Future: customer confirm delivery via WhatsApp |
| Push notifications / reminders | Not implemented | Future: remind customers before order window closes |

---

## 15. Deployment (Railway)

1. Push code to GitHub (`.env`, `.pem`, `generateKeys.js`, `uploadPublicKey.js` are gitignored)
2. Connect Railway to GitHub repo
3. Set all environment variables in Railway dashboard (see Section 11)
4. For `FLOW_PRIVATE_KEY`: paste the contents of `private.pem` as a single-line string with `\n` for newlines
5. Frontend: deploy `vendor-dashboard` as a separate Railway service or Vercel
6. Update `APP_BASE_URL` and `CORS_ORIGIN` to production URLs

---

## 16. How to Add a New Vendor

1. Insert row into `vendors` table with their `phone_number_id` (from Meta)
2. Run `uploadPublicKey.js` with their `phone_number_id` (updates Meta encryption key)
3. Subscribe their phone number to the webhook in Meta App Dashboard
4. Share dashboard link: `POST /auth/vendor-link` with their WhatsApp number
