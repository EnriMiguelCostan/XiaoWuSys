const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Connect to the local SQLite file
const dbPath = path.resolve(__dirname, 'local_cache.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error connecting to SQLite:', err.message);
    process.exit(1);
  }
  console.log('✅ Connected to SQLite Local Cache.');
});

// Run commands sequentially
db.serialize(() => {
  // Enforce foreign key constraints
  db.run("PRAGMA foreign_keys = ON;");

  console.log('⏳ Creating tables if they do not exist...');

  // 1. Inventory Items
  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_items (
        inventory_id TEXT PRIMARY KEY,
        item_name TEXT NOT NULL,
        item_category TEXT NOT NULL,
        quantity_available INTEGER NOT NULL DEFAULT 0,
        quantity_reserved INTEGER NOT NULL DEFAULT 0,
        minimum_threshold INTEGER NOT NULL DEFAULT 0,
        unit_cost REAL NOT NULL,
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // 2. Users
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Owner', 'Admin', 'Production', 'Staff')),
      sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
      last_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Customers
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
        customer_id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        contact_number TEXT,
        platform_source TEXT,
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Order Profiles
  db.run(`
    CREATE TABLE IF NOT EXISTS order_profiles (
        order_id TEXT PRIMARY KEY,
        customer_id TEXT REFERENCES customers(customer_id) ON DELETE RESTRICT,
        date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
        production_deadline DATETIME NOT NULL,
        production_status TEXT DEFAULT 'Pending' CHECK (production_status IN ('Pending', 'Printing', 'Completed', 'Delayed', 'Cancelled')),
        design_drive_link TEXT,
        total_quote_amount REAL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. Order Items
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
        line_item_id TEXT PRIMARY KEY,
        order_id TEXT REFERENCES order_profiles(order_id) ON DELETE CASCADE,
        inventory_id TEXT REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
        product_type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        size TEXT,
        custom_name TEXT,
        custom_number TEXT,
        price REAL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 6. Payments
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
        payment_id TEXT PRIMARY KEY,
        order_id TEXT REFERENCES order_profiles(order_id) ON DELETE CASCADE,
        amount REAL NOT NULL,
        payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        payment_type TEXT NOT NULL CHECK (payment_type IN ('Cash', 'GCash', 'Bank Transfer')),
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 7. Material Loss
  db.run(`
    CREATE TABLE IF NOT EXISTS material_loss (
        loss_id TEXT PRIMARY KEY,
        order_id TEXT REFERENCES order_profiles(order_id) ON DELETE SET NULL,
        inventory_id TEXT REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
        quantity_lost INTEGER NOT NULL,
        loss_reason TEXT NOT NULL,
        date_recorded DATETIME DEFAULT CURRENT_TIMESTAMP,
        financial_cost REAL NOT NULL DEFAULT 0.00,
        sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('🎉 SQLite schema initialization complete!');
});

// Close the database connection when finished
db.close();