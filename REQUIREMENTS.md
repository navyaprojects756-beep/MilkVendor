# MilkWhatsAppBot - Current Requirements And Change Log

> Last updated: 2026-04-03  
> This file reflects the current backend and frontend behavior after the recent WhatsApp flow, pause/resume, delivery charge, IST timezone, and dashboard updates.

---

## 1. Project Summary

MilkWhatsAppBot is a multi-vendor milk and dairy delivery platform with:

- A WhatsApp-first customer journey for registration, profile updates, daily subscriptions, quick orders, pause/resume, billing, and support messages.
- A vendor dashboard for products, customers, orders, pauses, messages, billing, payments, and settings.

The current system supports:

- Multi-product daily subscriptions
- Quick orders for upcoming deliveries
- Shared WhatsApp Flows for both subscription and adhoc product selection
- One order containing both daily and extra items
- IST-safe business dates even when hosting/database are outside India

---

## 2. Technology Stack

### Backend

- Node.js
- Express
- PostgreSQL
- Meta WhatsApp Cloud API
- JWT authentication for vendor dashboard
- PDFKit for invoice generation
- Multer for uploads
- AES-128-GCM + RSA OAEP for WhatsApp Flow payload encryption

### Frontend

- React + Vite
- MUI dashboard UI
- React Router

---

## 3. Important Database Model

### Core tables

- `vendors`
- `vendor_profile`
- `vendor_settings`
- `customers`
- `customer_vendor_profile`
- `subscriptions`
- `customer_subscriptions`
- `products`
- `orders`
- `order_items`
- `subscription_pauses`
- `payments`
- `messages`
- `apartments`
- `apartment_blocks`

### Newer fields / tables now in use

- `orders.delivery_charge_amount`
- `vendor_settings.apply_delivery_charge_on_subscription`
- `paused_orders_archive`
- `paused_order_items_archive`

### Subscription model

- `subscriptions` is the base customer-vendor subscription record.
- `customer_subscriptions` stores per-product daily subscription quantities.
- One customer can have multiple active daily product rows.

### Order model

- One `orders` row exists per customer, vendor, and delivery date.
- `order_items` stores all product lines in that order.
- A single order can contain:
  - `subscription` items
  - `adhoc` items

---

## 4. WhatsApp Customer Experience

### Registration and profile update

- Customer registration uses a WhatsApp Flow.
- The same flow is reused for profile editing.
- Existing profile/address values are prefilled when editing profile.
- Registration is now sent as a direct interactive flow message inside the active chat session.
- Registration no longer depends on a WhatsApp template for normal in-session onboarding.

Prefill includes:

- customer name
- address type
- apartment
- block
- flat number
- manual address

### Greeting and reset

When customer sends:

- `hi`
- `hello`
- `start`
- `menu`

the bot resets to the main menu state.

`How can we help you today?` should appear only on greeting/reset menu entry, not after every completed action.

### Main menu labels

Current WhatsApp menu language should be:

- `View Orders & Plan`
- `Daily Subscription`
- `Change Daily Products`
- `Order Tomorrow`
- `Profile`
- `Pause Delivery`
- `Resume Now`
- `Get Bill`

### Free-text messages

If customer sends any unstructured text:

- save it in `messages`
- send an acknowledgement
- show menu again

These messages should be visible in the vendor dashboard messages page.

---

## 5. WhatsApp Product Flows

### Shared flow approach

One shared Meta flow is used for both:

- daily subscription updates
- quick/tomorrow orders

Mode comes from `flow_token`:

- `vendorId:customerId:sub`
- `vendorId:customerId:adhoc`

### Flow screens

- `PRODUCT_LIST`
- `PRODUCT_LIST_ADHOC`
- `SUCCESS`

### Flow behavior

- Subscription mode saves directly into `customer_subscriptions`
- Adhoc mode stores a cart in conversation state, then customer confirms in WhatsApp
- Flow JSON can be reused across vendors when their phone numbers belong to the same WhatsApp Business Account context.

### Prefill rules

- Daily product flow prefills only active daily subscription quantities
- Quick order flow prefills only existing upcoming adhoc quantities
- First-time product selection should open blank

---

## 6. Orders And Delivery Charges

### Daily + adhoc in one order

An order for a future date can contain both:

- daily subscription items
- extra/quick-order items

Customer-facing display should reflect both.

### Delivery charge rules

Delivery charge is now order-level, not product-level.

Rules:

- Only one delivery charge per order
- If a future order has both daily and quick-order items, charge once only
- `vendor_settings.apply_delivery_charge_on_subscription` decides whether a subscription-only order should carry delivery charge
- Adhoc/quick-order orders use the vendor order delivery charge if configured

### Order creation

- Daily subscription orders are generated for today and tomorrow
- Quick orders are added into the matching upcoming `orders` row for that delivery date
- The same order can contain both daily and extra items

---

## 7. Pause And Resume Rules

### Pause behavior

Pause applies to:

- daily subscription deliveries
- tomorrow/extra quick-order items

Customer WhatsApp message should clearly say that all deliveries in the pause period are paused.

### Paused menu behavior

While paused, customer menu should show only:

- `Resume Now`
- `Profile`
- `Get Bill`

### Resume behavior

On resume:

- pause row is removed
- paused upcoming orders are restored from archive
- upcoming daily snapshot is regenerated
- customer should again see both daily and quick upcoming items

### Pause archive

Pause archive tables preserve future orders through pause/resume:

- `paused_orders_archive`
- `paused_order_items_archive`

---

## 8. IST Timezone Policy

All business dates must use IST (`Asia/Kolkata`) regardless of hosting region.

This applies to:

- tomorrow calculations
- pause dates
- invoice dates
- payment dates
- order generation
- customer WhatsApp messages
- dashboard display

### Backend files using IST-safe logic

- `bots/customerBot.js`
- `bots/vendorBot.js`
- `routes/vendorDashboard.js`
- `services/orderGenerator.js`
- `services/invoicePDF.js`

### Frontend files using IST-safe logic

- `vendor-dashboard/src/utils/istDate.js`
- `Orders.jsx`
- `Customers.jsx`
- `Messages.jsx`
- `Products.jsx`
- `Pauses.jsx`

---

## 9. Billing And Outstanding

### Billing rules

Bills and outstanding amounts must be calculated from delivered orders and real order totals.

Current rules:

- use `order_items` when available
- include `orders.delivery_charge_amount`
- count only delivered orders in invoices
- use payment status to determine outstanding amount

### Customer bill flow

Customer can request bill from WhatsApp.

System sends:

- summary text
- PDF invoice

### PDF invoice

PDF is generated from delivered order rows and IST-safe date labels.

---

## 10. Vendor Dashboard Requirements

### Orders page

Orders page should support:

- date filters
- apartment and block filters
- compact cards
- row-wise expand/collapse
- `Expand All`
- `Collapse All`

User-friendly labels should be used instead of raw internal words:

- `Daily`
- `Tomorrow`

Paused future orders should not appear in the active orders list.

### Customers page

Customer billing and outstanding should always reflect the latest delivered values.

### Products page

Products support:

- name
- unit
- price
- order type (`subscription`, `adhoc`, `both`)
- active status

Per-product delivery charge is no longer the active total-calculation model.

### Pauses page

Pause page should show:

- paused from
- resumes on
- apartment/address
- days left / manual resume
- apartment filter

Pause dates on dashboard must match WhatsApp pause dates exactly.

### Messages page

Shows inbound customer free-text messages for vendor review.

### Settings page

Settings currently include:

- delivery timings
- order acceptance window
- subscription delivery charge toggle
- vendor business settings

Profile updates and other maintenance actions should still be allowed outside the order acceptance window.

---

## 11. Multi-Vendor WhatsApp Setup

### Recommended Meta setup

For this project, the preferred Meta setup is:

- one WhatsApp Business Account
- multiple phone numbers under that same account
- one vendor mapped to one `phone_number_id`

This setup makes it easier to reuse:

- flows
- templates
- webhook setup
- onboarding process

### Vendor routing

Backend routes incoming messages by `phone_number_id`.

Current vendor mapping expectation:

- each vendor row has its own `phone_number_id`
- backend picks vendor by the incoming WhatsApp metadata phone number id

### Template and flow notes

- Direct interactive flows work inside the active 24-hour customer service window.
- Registration currently uses direct interactive flow, not template-based sending.
- Product selection and profile update also use direct interactive flows.
- If business-initiated messaging is needed outside the active session window, templates are still required by Meta.
- When phone numbers are spread across different WhatsApp account contexts, the same flow/template may need to be created there too.

---

## 12. Key Backend Files

- `server.js`
- `bots/customerBot.js`
- `bots/vendorBot.js`
- `routes/vendorDashboard.js`
- `routes/customerFlowExchange.js`
- `services/orderGenerator.js`
- `services/orderPricing.js`
- `services/invoicePDF.js`

---

## 13. Key Frontend Files

- `vendor-dashboard/src/App.jsx`
- `vendor-dashboard/src/dashboard/pages/Orders.jsx`
- `vendor-dashboard/src/dashboard/pages/Customers.jsx`
- `vendor-dashboard/src/dashboard/pages/Products.jsx`
- `vendor-dashboard/src/dashboard/pages/Pauses.jsx`
- `vendor-dashboard/src/dashboard/pages/Messages.jsx`
- `vendor-dashboard/src/dashboard/pages/Settings.jsx`
- `vendor-dashboard/src/utils/istDate.js`

---

## 14. Important Recent Migrations

These should exist in the database:

- `migrations/order_level_delivery_charge.sql`
- `migrations/ist_date_defaults_and_pause_cleanup.sql`
- `migrations/pause_order_archive.sql`

They support:

- order-level delivery charges
- IST-safe defaults
- pause cleanup
- pause archive and restore

---

## 15. Current Operational Rules

- Use IST dates everywhere for customer and vendor business logic
- One delivery charge per order
- `View Orders & Plan` must show both daily and upcoming extra items
- `hi` / `menu` resets state to start menu
- Pause and resume must preserve upcoming future deliveries
- Dashboard pause dates must match WhatsApp pause dates
- Delivered orders drive invoices and outstanding values

---

## 16. Current Known Debug Area

One area still under active verification during live testing:

- some quick-order write/display paths depend on exact `orders` + `order_items` state and older rows in the database

When debugging this area, inspect:

- `orders`
- `order_items`
- `conversation_state.temp_data`
- `products`
- `subscriptions`
- `customer_subscriptions`
