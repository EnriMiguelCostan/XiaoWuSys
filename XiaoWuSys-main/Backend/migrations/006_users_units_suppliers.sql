-- ==========================================
-- 006: account management + item units and suppliers
-- Idempotent. Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- 1. Accounts can be deactivated (instead of deleted, so their history stays readable)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
-- Sessions (JWTs) issued before this moment are rejected: set on deactivate / password reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMP;

-- 2. Inventory: what one unit means (pcs, pack, ream, meter...) and who supplies it
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit VARCHAR(30) NOT NULL DEFAULT 'pcs';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
