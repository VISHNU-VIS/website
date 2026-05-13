const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { db, init, run, get, all } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-change-me';
const upload = multer({
  dest: path.join(__dirname, 'public', 'uploads'),
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only image uploads are allowed'), false);
    }
    cb(null, true);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({ secret: 'session-secret', resave: false, saveUninitialized: true }));

function flash(req, key, message) {
  if (!req.session.messages) req.session.messages = {};
  req.session.messages[key] = message;
}

function getFlash(req, key) {
  const value = req.session.messages?.[key];
  if (req.session.messages) delete req.session.messages[key];
  return value;
}

async function loadSettings() {
  const rows = await all(`SELECT key, value FROM settings`);
  const settings = {};
  rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  app.locals.settings = settings;
}

function createToken(admin) {
  return jwt.sign({ id: admin.id, email: admin.email }, JWT_SECRET, { expiresIn: '8h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function adminGuard(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.redirect('/admin/login');

  const payload = verifyToken(token);
  if (!payload) return res.redirect('/admin/login');

  req.admin = payload;
  next();
}

function ensureCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

app.locals.formatCurrency = formatCurrency;

app.get('/', async (req, res) => {
  const featured = await all(`SELECT * FROM products WHERE featured = 1 AND active = 1 ORDER BY created_at DESC LIMIT 6`);
  const retail = await all(`SELECT * FROM products WHERE active = 1 AND (type = 'Retail' OR type = 'Both') ORDER BY created_at DESC LIMIT 4`);
  const wholesale = await all(`SELECT * FROM products WHERE active = 1 AND (type = 'Wholesale' OR type = 'Both') ORDER BY created_at DESC LIMIT 4`);
  res.render('index', {
    featured,
    retail,
    wholesale,
    message: getFlash(req, 'success')
  });
});

app.get('/products', async (req, res) => {
  const { category, type, search } = req.query;
  let query = `SELECT * FROM products WHERE active = 1`;
  const params = [];
  if (category) {
    query += ` AND category = ?`;
    params.push(category);
  }
  if (type) {
    if (type === 'Retail') query += ` AND (type = 'Retail' OR type = 'Both')`;
    else if (type === 'Wholesale') query += ` AND (type = 'Wholesale' OR type = 'Both')`;
  }
  if (search) {
    query += ` AND (name LIKE ? OR description LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  const products = await all(query, params);
  const categories = await all(`SELECT DISTINCT category FROM products WHERE active = 1 ORDER BY category`);
  res.render('products', { products, categories, filters: { category, type, search } });
});

app.get('/product/:id', async (req, res) => {
  const product = await get(`SELECT * FROM products WHERE id = ? AND active = 1`, [req.params.id]);
  if (!product) return res.status(404).send('Product not found');
  product.images = JSON.parse(product.images || '[]');
  res.render('product', {
    product,
    message: getFlash(req, 'success'),
    error: getFlash(req, 'error')
  });
});

app.post('/cart/add', async (req, res) => {
  const { product_id, quantity, customer_type } = req.body;
  const product = await get(`SELECT * FROM products WHERE id = ? AND active = 1`, [product_id]);
  if (!product) {
    flash(req, 'error', 'Product unavailable.');
    return res.redirect('back');
  }
  const qty = Number(quantity) || 1;
  if (customer_type === 'Wholesale' && qty < Math.max(1, product.moq)) {
    flash(req, 'error', `Wholesale orders require a minimum quantity of ${product.moq}.`);
    return res.redirect(`/product/${product_id}`);
  }
  if (qty > product.stock) {
    flash(req, 'error', 'Quantity exceeds available stock.');
    return res.redirect(`/product/${product_id}`);
  }
  const cart = ensureCart(req);
  const existing = cart.find((item) => item.product_id === product.id && item.customer_type === customer_type);
  const price = customer_type === 'Wholesale' ? product.wholesale_price : product.retail_price;
  const minQty = customer_type === 'Wholesale' ? product.moq : 1;
  const targetQty = existing ? existing.quantity + qty : qty;
  if (customer_type === 'Wholesale' && targetQty < minQty) {
    flash(req, 'error', `Minimum wholesale quantity is ${product.moq}.`);
    return res.redirect(`/product/${product_id}`);
  }
  if (targetQty > product.stock) {
    flash(req, 'error', 'Cannot add more than stock allows.');
    return res.redirect(`/product/${product_id}`);
  }
  if (existing) {
    existing.quantity = targetQty;
  } else {
    cart.push({
      product_id: product.id,
      name: product.name,
      customer_type,
      quantity: qty,
      unit_price: price,
      moq: minQty,
      stock: product.stock,
      image: JSON.parse(product.images || '[]')[0] || ''
    });
  }
  flash(req, 'success', 'Item added to cart.');
  res.redirect('/cart');
});

app.post('/cart/update', async (req, res) => {
  const cart = ensureCart(req);
  const updates = req.body.quantity || {};
  for (const [key, value] of Object.entries(updates)) {
    const index = Number(key);
    const item = cart[index];
    if (!item) continue;
    const qty = Number(value) || 1;
    const product = await get(`SELECT stock FROM products WHERE id = ?`, [item.product_id]);
    if (!product) continue;
    if (item.customer_type === 'Wholesale' && qty < item.moq) continue;
    if (qty > product.stock) continue;
    item.quantity = qty;
  }
  flash(req, 'success', 'Cart updated.');
  res.redirect('/cart');
});

app.post('/cart/remove', (req, res) => {
  const cart = ensureCart(req);
  const index = Number(req.body.index);
  if (!Number.isNaN(index) && cart[index]) {
    cart.splice(index, 1);
  }
  flash(req, 'success', 'Item removed from cart.');
  res.redirect('/cart');
});

app.get('/cart', (req, res) => {
  const cart = ensureCart(req);
  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  res.render('cart', { cart, subtotal, message: getFlash(req, 'success'), error: getFlash(req, 'error') });
});

app.get('/checkout', (req, res) => {
  const cart = ensureCart(req);
  if (!cart.length) {
    flash(req, 'error', 'Your cart is empty.');
    return res.redirect('/cart');
  }
  const subtotal = cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  res.render('checkout', {
    cart,
    subtotal,
    gpayQr: app.locals.settings.gpay_qr,
    message: getFlash(req, 'success'),
    error: getFlash(req, 'error')
  });
});

app.post('/checkout', async (req, res) => {
  const { fullName, email, phone, address, orderNotes, transactionId } = req.body;
  const cart = ensureCart(req);
  if (!cart.length) {
    flash(req, 'error', 'Your cart is empty.');
    return res.redirect('/cart');
  }
  if (!fullName || !email || !phone || !address || !transactionId) {
    flash(req, 'error', 'Please fill all required fields and provide the transaction ID.');
    return res.redirect('/checkout');
  }

  const total = cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const order = await run(`INSERT INTO orders (customer_name, email, phone, delivery_address, order_notes, transaction_id, total_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    fullName,
    email,
    phone,
    address,
    orderNotes || '',
    transactionId,
    total
  ]);
  const orderId = order.lastID;
  for (const item of cart) {
    await run(`INSERT INTO order_items (order_id, product_id, name, customer_type, quantity, unit_price, total_price, moq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      orderId,
      item.product_id,
      item.name,
      item.customer_type,
      item.quantity,
      item.unit_price,
      item.quantity * item.unit_price,
      item.moq
    ]);
  }
  req.session.cart = [];
  flash(req, 'success', 'Order placed successfully. Status: Pending Payment Confirmation.');
  res.redirect('/');
});

app.get('/contact', (req, res) => {
  res.render('contact', { message: getFlash(req, 'success'), error: getFlash(req, 'error') });
});

app.post('/contact', async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  if (!name || !email || !subject || !message) {
    flash(req, 'error', 'Please fill out all required contact fields.');
    return res.redirect('/contact');
  }
  await run(`INSERT INTO contacts (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)`, [name, email, phone, subject, message]);
  flash(req, 'success', 'Your message has been saved. We will get back to you soon.');
  res.redirect('/contact');
});

app.get('/inquiry', (req, res) => {
  res.render('inquiry', { message: getFlash(req, 'success'), error: getFlash(req, 'error') });
});

app.post('/inquiry', async (req, res) => {
  const { name, email, phone, productInterest, quantityNeeded, message } = req.body;
  if (!name || !email || !productInterest || !quantityNeeded || !message) {
    flash(req, 'error', 'Please complete all inquiry fields.');
    return res.redirect('/inquiry');
  }
  await run(`INSERT INTO inquiries (name, email, phone, product_interest, quantity_needed, message) VALUES (?, ?, ?, ?, ?, ?)`, [
    name,
    email,
    phone,
    productInterest,
    quantityNeeded,
    message
  ]);
  flash(req, 'success', 'Inquiry submitted successfully. Status: New.');
  res.redirect('/inquiry');
});

app.get('/feedback', (req, res) => {
  res.render('feedback', { message: getFlash(req, 'success'), error: getFlash(req, 'error') });
});

app.post('/feedback', async (req, res) => {
  const { name, email, rating, comment } = req.body;
  if (!name || !email || !rating || !comment) {
    flash(req, 'error', 'Please complete all feedback fields.');
    return res.redirect('/feedback');
  }
  await run(`INSERT INTO feedbacks (name, email, rating, comment) VALUES (?, ?, ?, ?)`, [
    name,
    email,
    rating,
    comment
  ]);
  flash(req, 'success', 'Feedback submitted. Thank you for your review!');
  res.redirect('/feedback');
});

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: getFlash(req, 'error') });
});

app.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const admin = await get(`SELECT * FROM admins WHERE email = ?`, [email]);
  if (!admin) {
    flash(req, 'error', 'Invalid login credentials.');
    return res.redirect('/admin/login');
  }
  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    flash(req, 'error', 'Invalid login credentials.');
    return res.redirect('/admin/login');
  }
  const token = createToken(admin);
  res.cookie('admin_token', token, { httpOnly: true, maxAge: 8 * 3600 * 1000 });
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', adminGuard, async (req, res) => {
  const totalOrders = await get(`SELECT COUNT(*) as count FROM orders`);
  const pendingOrders = await get(`SELECT COUNT(*) as count FROM orders WHERE payment_status = 'Pending Payment Confirmation'`);
  const newInquiries = await get(`SELECT COUNT(*) as count FROM inquiries WHERE status = 'New'`);
  const newMessages = await get(`SELECT COUNT(*) as count FROM contacts WHERE status = 'Unread'`);
  const totalProducts = await get(`SELECT COUNT(*) as count FROM products`);
  const lowStock = await get(`SELECT COUNT(*) as count FROM products WHERE stock <= 5`);
  res.render('admin/dashboard', {
    stats: {
      totalOrders: totalOrders.count,
      pendingOrders: pendingOrders.count,
      newInquiries: newInquiries.count,
      newMessages: newMessages.count,
      totalProducts: totalProducts.count,
      lowStock: lowStock.count
    }
  });
});

app.get('/admin/products', adminGuard, async (req, res) => {
  const products = await all(`SELECT * FROM products ORDER BY created_at DESC`);
  products.forEach((product) => {
    product.images = JSON.parse(product.images || '[]');
  });
  res.render('admin/products', { products, message: getFlash(req, 'success') });
});

app.get('/admin/product/new', adminGuard, (req, res) => {
  res.render('admin/product_form', { product: null, error: getFlash(req, 'error') });
});

app.post('/admin/product/new', adminGuard, upload.array('images', 6), async (req, res) => {
  const { name, description, category, type, retail_price, wholesale_price, moq, stock, featured, active } = req.body;
  if (!name || !type) {
    flash(req, 'error', 'Name and type are required.');
    return res.redirect('/admin/product/new');
  }
  const filePaths = req.files.map((file) => `/uploads/${path.basename(file.path)}`);
  const images = JSON.stringify(filePaths);
  await run(`INSERT INTO products (name, description, category, type, retail_price, wholesale_price, moq, stock, images, featured, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    name,
    description,
    category,
    type,
    Number(retail_price) || 0,
    Number(wholesale_price) || 0,
    Number(moq) || 1,
    Number(stock) || 0,
    images,
    featured ? 1 : 0,
    active ? 1 : 0
  ]);
  flash(req, 'success', 'Product saved successfully.');
  res.redirect('/admin/products');
});

app.get('/admin/product/:id/edit', adminGuard, async (req, res) => {
  const product = await get(`SELECT * FROM products WHERE id = ?`, [req.params.id]);
  if (!product) return res.redirect('/admin/products');
  product.images = JSON.parse(product.images || '[]');
  res.render('admin/product_form', { product, error: getFlash(req, 'error') });
});

app.post('/admin/product/:id/edit', adminGuard, upload.array('images', 6), async (req, res) => {
  const { name, description, category, type, retail_price, wholesale_price, moq, stock, featured, active, existingImages } = req.body;
  const product = await get(`SELECT * FROM products WHERE id = ?`, [req.params.id]);
  if (!product) return res.redirect('/admin/products');
  const keepImages = Array.isArray(existingImages) ? existingImages : existingImages ? [existingImages] : [];
  const filePaths = req.files.map((file) => `/uploads/${path.basename(file.path)}`);
  const images = JSON.stringify([...keepImages, ...filePaths]);
  await run(`UPDATE products SET name = ?, description = ?, category = ?, type = ?, retail_price = ?, wholesale_price = ?, moq = ?, stock = ?, images = ?, featured = ?, active = ? WHERE id = ?`, [
    name,
    description,
    category,
    type,
    Number(retail_price) || 0,
    Number(wholesale_price) || 0,
    Number(moq) || 1,
    Number(stock) || 0,
    images,
    featured ? 1 : 0,
    active ? 1 : 0,
    req.params.id
  ]);
  flash(req, 'success', 'Product updated successfully.');
  res.redirect('/admin/products');
});

app.post('/admin/product/:id/delete', adminGuard, async (req, res) => {
  await run(`DELETE FROM products WHERE id = ?`, [req.params.id]);
  flash(req, 'success', 'Product deleted successfully.');
  res.redirect('/admin/products');
});

app.get('/admin/orders', adminGuard, async (req, res) => {
  const { status, startDate, endDate } = req.query;
  let query = `SELECT * FROM orders WHERE 1=1`;
  const params = [];
  if (status) {
    query += ` AND order_status = ?`;
    params.push(status);
  }
  if (startDate) {
    query += ` AND date(created_at) >= date(?)`;
    params.push(startDate);
  }
  if (endDate) {
    query += ` AND date(created_at) <= date(?)`;
    params.push(endDate);
  }
  const orders = await all(query + ' ORDER BY created_at DESC', params);
  res.render('admin/orders', { orders, filters: { status, startDate, endDate }, message: getFlash(req, 'success') });
});

app.get('/admin/order/:id', adminGuard, async (req, res) => {
  const order = await get(`SELECT * FROM orders WHERE id = ?`, [req.params.id]);
  if (!order) return res.redirect('/admin/orders');
  const items = await all(`SELECT * FROM order_items WHERE order_id = ?`, [order.id]);
  res.render('admin/order_detail', { order, items, message: getFlash(req, 'success') });
});

app.post('/admin/order/:id/update', adminGuard, async (req, res) => {
  const { payment_status, order_status, notes } = req.body;
  await run(`UPDATE orders SET payment_status = ?, order_status = ?, order_notes = ? WHERE id = ?`, [
    payment_status,
    order_status,
    notes || '',
    req.params.id
  ]);
  flash(req, 'success', 'Order updated successfully.');
  res.redirect(`/admin/order/${req.params.id}`);
});

app.get('/admin/inquiries', adminGuard, async (req, res) => {
  const inquiries = await all(`SELECT * FROM inquiries ORDER BY created_at DESC`);
  res.render('admin/inquiries', { inquiries, message: getFlash(req, 'success') });
});

app.get('/admin/inquiry/:id', adminGuard, async (req, res) => {
  const inquiry = await get(`SELECT * FROM inquiries WHERE id = ?`, [req.params.id]);
  if (!inquiry) return res.redirect('/admin/inquiries');
  res.render('admin/inquiry_detail', { inquiry, message: getFlash(req, 'success') });
});

app.post('/admin/inquiry/:id/status', adminGuard, async (req, res) => {
  const { status, notes } = req.body;
  await run(`UPDATE inquiries SET status = ?, notes = ? WHERE id = ?`, [status, notes || '', req.params.id]);
  flash(req, 'success', 'Inquiry updated successfully.');
  res.redirect(`/admin/inquiry/${req.params.id}`);
});

app.get('/admin/contacts', adminGuard, async (req, res) => {
  const contacts = await all(`SELECT * FROM contacts ORDER BY created_at DESC`);
  res.render('admin/contacts', { contacts, message: getFlash(req, 'success') });
});

app.get('/admin/contact/:id', adminGuard, async (req, res) => {
  const contact = await get(`SELECT * FROM contacts WHERE id = ?`, [req.params.id]);
  if (!contact) return res.redirect('/admin/contacts');
  res.render('admin/contact_detail', { contact, message: getFlash(req, 'success') });
});

app.post('/admin/contact/:id/status', adminGuard, async (req, res) => {
  const { status, notes } = req.body;
  await run(`UPDATE contacts SET status = ?, notes = ? WHERE id = ?`, [status, notes || '', req.params.id]);
  flash(req, 'success', 'Contact message updated successfully.');
  res.redirect(`/admin/contact/${req.params.id}`);
});

app.get('/admin/feedbacks', adminGuard, async (req, res) => {
  const feedbacks = await all(`SELECT * FROM feedbacks ORDER BY created_at DESC`);
  res.render('admin/feedbacks', { feedbacks, message: getFlash(req, 'success') });
});

app.post('/admin/feedback/:id/status', adminGuard, async (req, res) => {
  const { action } = req.body;
  const approved = action === 'approve' ? 1 : 0;
  const status = action === 'approve' ? 'Approved' : 'Rejected';
  await run(`UPDATE feedbacks SET approved = ?, status = ? WHERE id = ?`, [approved, status, req.params.id]);
  flash(req, 'success', 'Feedback status updated.');
  res.redirect('/admin/feedbacks');
});

app.post('/admin/feedback/:id/delete', adminGuard, async (req, res) => {
  await run(`DELETE FROM feedbacks WHERE id = ?`, [req.params.id]);
  flash(req, 'success', 'Feedback deleted.');
  res.redirect('/admin/feedbacks');
});

app.get('/admin/settings', adminGuard, async (req, res) => {
  res.render('admin/settings', { settings: app.locals.settings, message: getFlash(req, 'success'), error: getFlash(req, 'error') });
});

app.post('/admin/settings', adminGuard, upload.single('gpay_qr'), async (req, res) => {
  const { shop_name, shop_tagline, meta_title, meta_description, admin_email, admin_password } = req.body;
  const updates = [
    ['shop_name', shop_name],
    ['shop_tagline', shop_tagline],
    ['meta_title', meta_title],
    ['meta_description', meta_description]
  ];

  for (const [key, value] of updates) {
    await run(`UPDATE settings SET value = ? WHERE key = ?`, [value || '', key]);
  }

  if (req.file) {
    const gpayPath = `/uploads/${path.basename(req.file.path)}`;
    await run(`UPDATE settings SET value = ? WHERE key = 'gpay_qr'`, [gpayPath]);
  }

  if (admin_email) {
    await run(`UPDATE admins SET email = ? WHERE id = 1`, [admin_email]);
  }
  if (admin_password) {
    const hash = await bcrypt.hash(admin_password, 10);
    await run(`UPDATE admins SET password_hash = ? WHERE id = 1`, [hash]);
  }

  await loadSettings();
  flash(req, 'success', 'Settings saved successfully.');
  res.redirect('/admin/settings');
});

app.use((req, res) => {
  res.status(404).send('Page not found');
});

(async () => {
  await init();
  await loadSettings();
  const placeholderPath = path.join(__dirname, 'public', 'uploads', 'gpay-qr-placeholder.png');
  if (!fs.existsSync(placeholderPath)) {
    fs.writeFileSync(placeholderPath, '');
  }
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
})();
