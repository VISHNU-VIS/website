const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const dbFile = path.join(__dirname, 'data', 'store.db');
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbFile);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    type TEXT NOT NULL,
    retail_price REAL DEFAULT 0,
    wholesale_price REAL DEFAULT 0,
    moq INTEGER DEFAULT 1,
    stock INTEGER DEFAULT 0,
    images TEXT,
    featured INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT,
    subject TEXT,
    message TEXT,
    status TEXT DEFAULT 'Unread',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT,
    product_interest TEXT,
    quantity_needed TEXT,
    message TEXT,
    status TEXT DEFAULT 'New',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    rating INTEGER,
    comment TEXT,
    status TEXT DEFAULT 'Pending',
    approved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT,
    email TEXT,
    phone TEXT,
    delivery_address TEXT,
    order_notes TEXT,
    payment_status TEXT DEFAULT 'Pending Payment Confirmation',
    order_status TEXT DEFAULT 'Pending',
    transaction_id TEXT,
    total_amount REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    product_id INTEGER,
    name TEXT,
    customer_type TEXT,
    quantity INTEGER,
    unit_price REAL,
    total_price REAL,
    moq INTEGER,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);

  const admin = await get(`SELECT * FROM admins WHERE email = ?`, ['admin@example.com']);
  if (!admin) {
    const hash = await bcrypt.hash('Password123', 10);
    await run(`INSERT INTO admins (email, password_hash) VALUES (?, ?)`, ['admin@example.com', hash]);
  }

  const defaultSettings = [
    ['shop_name', 'My Store'],
    ['shop_tagline', 'Quality goods for retail and wholesale customers'],
    ['meta_title', 'My Store - Retail & Wholesale Ecommerce'],
    ['meta_description', 'Shop retail and wholesale products with MOQ support, admin portal, orders, and customer forms.'],
    ['gpay_qr', '/images/placeholder.svg']
  ];

  for (const [key, value] of defaultSettings) {
    const existing = await get(`SELECT value FROM settings WHERE key = ?`, [key]);
    if (!existing) {
      await run(`INSERT INTO settings (key, value) VALUES (?, ?)`, [key, value]);
    }
  }

  const anyProduct = await get(`SELECT id FROM products LIMIT 1`);
  if (!anyProduct) {
    await run(`INSERT INTO products (name, description, category, type, retail_price, wholesale_price, moq, stock, images, featured, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'Premium Cotton T-Shirt',
      'Soft cotton tee available in retail and wholesale pricing.',
      'Apparel',
      'Both',
      19.99,
      12.50,
      10,
      120,
      JSON.stringify(['/images/placeholder.svg']),
      1,
      1
    ]);
    await run(`INSERT INTO products (name, description, category, type, retail_price, wholesale_price, moq, stock, images, featured, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'Ceramic Coffee Mug',
      'Durable coffee mug with wholesale discount for bulk orders.',
      'Home & Kitchen',
      'Wholesale',
      0,
      4.00,
      25,
      340,
      JSON.stringify(['/images/placeholder.svg']),
      1,
      1
    ]);
  }
}

module.exports = { db, run, get, all, init };
