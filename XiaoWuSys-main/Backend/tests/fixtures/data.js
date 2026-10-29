// ==========================================
// TEST / DEMO DATA for XiaoMei Printshop (Agdao, Davao City)
// Used by the automated tests (tests/*.test.js) and by `npm run demo:seed`.
// Names and numbers are made up; mobile numbers follow the 11-digit 09XX format.
// ==========================================

// Every fixture account uses this password (meets the rule: 8+ characters, a letter and a number)
const PASSWORD = 'XiaoMei2026';

const USERS = [
  { user_id: 'u-owner', username: 'owner', role: 'Owner', is_active: 1 },
  { user_id: 'u-admin', username: 'admin', role: 'Admin', is_active: 1 },
  { user_id: 'u-production', username: 'production', role: 'Production', is_active: 1 },
  { user_id: 'u-staff', username: 'staff', role: 'Staff', is_active: 1 },
  { user_id: 'u-former', username: 'former.staff', role: 'Staff', is_active: 0 } // deactivated account
];

// The whiteboard inventory (the Oct 8, 2026 delivery plus the shop's usual consumables)
const ITEMS = [
  { item_name: 'Custom Shirt', item_category: 'Apparel', unit: 'pcs', quantity_available: 381, minimum_threshold: 50, unit_cost: 150, supplier: 'Davao Garments Supply' },
  { item_name: 'Valiant Record Book Regular Notebook', item_category: 'Notebooks', unit: 'pcs', quantity_available: 5, minimum_threshold: 2, unit_cost: 45 },
  { item_name: 'Valiant Columnar Notebook', item_category: 'Notebooks', unit: 'pcs', quantity_available: 3, minimum_threshold: 2, unit_cost: 55 },
  { item_name: 'Quaff Sublimation Transfer Paper', item_category: 'Paper', unit: 'pack', quantity_available: 1, minimum_threshold: 2, unit_cost: 650, supplier: 'Quaff PH' },
  { item_name: 'Deli A4 Paper', item_category: 'Paper', unit: 'ream', quantity_available: 1, minimum_threshold: 2, unit_cost: 245 },
  { item_name: 'B&E Oslo Drawing Paper', item_category: 'Paper', unit: 'pack', quantity_available: 9, minimum_threshold: 3, unit_cost: 38 },
  { item_name: 'Sales Invoice Receipts', item_category: 'Forms & Receipts', unit: 'pad', quantity_available: 12, minimum_threshold: 3, unit_cost: 85 },
  { item_name: 'Sublimation Ink (Cyan)', item_category: 'Ink', unit: 'bottle', quantity_available: 0, minimum_threshold: 1, unit_cost: 420, supplier: 'Quaff PH' },
  { item_name: 'Vinyl Sticker Paper', item_category: 'Paper', unit: 'pack', quantity_available: 20, minimum_threshold: 5, unit_cost: 120 }
];

const CUSTOMERS = [
  { full_name: 'Juan Dela Cruz', contact_number: '09171234567', platform_source: 'Facebook' },
  { full_name: 'Maria Santos', contact_number: '09281234567', platform_source: 'Messenger' },
  { full_name: 'Agdao National High School', contact_number: '09391234567', platform_source: 'Walk-in' }
];

module.exports = { PASSWORD, USERS, ITEMS, CUSTOMERS };
