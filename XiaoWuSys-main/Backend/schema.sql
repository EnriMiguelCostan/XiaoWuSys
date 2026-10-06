-- XiaoWuSys Neon PostgreSQL Schema
-- Run this directly in the Neon.tech SQL Editor
-- Then apply the migrations in migrations/ (e.g. the last_modified trigger): npm run migrate

-- 1. Users (Fixes D3 missing sync columns & D7 missing role rules)
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('Owner', 'Admin', 'Production', 'Staff')),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Inventory Items (Fixes D1 floating-point money error)
CREATE TABLE IF NOT EXISTS inventory_items (
    inventory_id VARCHAR(50) PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    item_category VARCHAR(100) NOT NULL,
    quantity_available INTEGER NOT NULL DEFAULT 0,
    quantity_reserved INTEGER NOT NULL DEFAULT 0,
    minimum_threshold INTEGER NOT NULL DEFAULT 0,
    unit_cost NUMERIC(10,2) NOT NULL,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Customers
CREATE TABLE IF NOT EXISTS customers (
    customer_id VARCHAR(50) PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    contact_number VARCHAR(50),
    platform_source VARCHAR(100),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Order Profiles (Fixes D1 money error, D2 strict dates, D7 status rules)
CREATE TABLE IF NOT EXISTS order_profiles (
    order_id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) REFERENCES customers(customer_id) ON DELETE RESTRICT,
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    production_deadline TIMESTAMP NOT NULL,
    production_status VARCHAR(50) DEFAULT 'Pending' CHECK (production_status IN ('Pending', 'Printing', 'Completed', 'Delayed', 'Cancelled')),
    design_drive_link TEXT,
    total_quote_amount NUMERIC(10,2) DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Order Items (Fixes D4 missing inventory links and price tracking)
CREATE TABLE IF NOT EXISTS order_items (
    line_item_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    inventory_id VARCHAR(50) REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    product_type VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL,
    size VARCHAR(50),
    custom_name VARCHAR(255),
    custom_number VARCHAR(50),
    price NUMERIC(10,2) DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Payments (Fixes D1 money error & D7 payment type rules)
CREATE TABLE IF NOT EXISTS payments (
    payment_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payment_type VARCHAR(50) NOT NULL CHECK (payment_type IN ('Cash', 'GCash', 'Bank Transfer')),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Material Loss (Fixes D1 money error)
CREATE TABLE IF NOT EXISTS material_loss (
    loss_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE SET NULL,
    inventory_id VARCHAR(50) REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    quantity_lost INTEGER NOT NULL,
    loss_reason TEXT NOT NULL,
    date_recorded TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    financial_cost NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);