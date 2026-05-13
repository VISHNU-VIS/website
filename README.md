# Ecommerce Website

A simple ecommerce storefront with customer-facing public pages, cart/checkout, contact/inquiry/feedback forms, and an admin panel with JWT login.

## Features
- Homepage with hero banner, featured products, retail/wholesale sections
- Product listing, search, category/type filters
- Product detail page with customer type toggle and MOQ enforcement
- Cart and checkout with GPay QR transaction flow
- Contact, inquiry, and feedback forms saved to SQLite
- Admin panel with login, product management, order management, inquiry/contact/feedback management, and settings

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the app:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000`

## Admin Access
- Email: `admin@example.com`
- Password: `Password123`

## Notes
- Data is stored in `data/store.db`
- Uploaded product images and QR codes are stored in `public/uploads`
- Settings are saved in the database and reflected immediately
