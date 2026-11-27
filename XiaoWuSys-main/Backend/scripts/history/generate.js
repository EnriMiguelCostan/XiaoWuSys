// ==========================================
// DEMO HISTORY GENERATOR (pure: no database, no packages)
//
// Builds a believable history for the XiaoMei printing shop from START_DAY to today, for a
// demo / defense database: suppliers, a catalog with selling prices and usage rates, clients
// (with branches), 20-40 orders a month with their whole life (quote, downpayment, approval,
// Printing (printing and pressing, counted per item) -> Ready -> Completed, delivery batches, final payment),
// cancellations with refunds, delayed orders, stock in / stock out / yearly stock counts,
// consumables taken by the usage rates, misprints and other waste, and monthly overheads.
//
// The money and stock rules are the app's own (services/domain/*): quotes by computeQuote()
// (volume tiers, labor, discounts), consumables by plannedDeductions(), average unit cost by
// averageAfterAddC(). Stock never goes below zero and never below what open orders hold: when
// an order needs more than is free, a supplier delivery (stock in) is recorded just before it.
//
// The same seed and the same "now" always give the same data.
//   generateHistory({ users, now, start, seed, ordersPerMonth }) -> { tables, counters, summary }
//   tables: { table_name: [row, ...] } in insert order; counters: { orders, receipts, documents }
// Timestamps are UTC 'YYYY-MM-DD HH:MM:SS' (like the TIMESTAMP columns); the shop is UTC+8.
// ==========================================
const { computeQuote } = require('../../services/domain/pricing');
const { cancellationTerms } = require('../../services/domain/orderPolicies');
const { plannedDeductions, triggersFor } = require('../../services/domain/consumables');
const { averageAfterAddC } = require('../../services/domain/stockDocuments');
const { REASON_CODES } = require('../../services/domain/wasteDiagnostics');

const START_DAY = '2020-01-01';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const SHOP_OFFSET = 8 * HOUR; // Asia/Manila, no daylight saving

// ---------------------------------------------------------------------------------------------
// Random numbers (mulberry32): the same seed always gives the same history
// ---------------------------------------------------------------------------------------------
const makeRandom = (seed) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const chance = (p) => next() < p;
  const weighted = (pairs) => {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = next() * total;
    for (const [value, w] of pairs) {
      r -= w;
      if (r < 0) return value;
    }
    return pairs[pairs.length - 1][0];
  };
  const hex = (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join('');
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(next() * 4)]}${hex(3)}-${hex(12)}`;
  const digits = (n) => Array.from({ length: n }, () => Math.floor(next() * 10)).join('');
  return { next, int, pick, chance, weighted, hex, uuid, digits };
};

// ---------------------------------------------------------------------------------------------
// Time helpers (ms since epoch, UTC)
// ---------------------------------------------------------------------------------------------
const utcText = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const shopDay = (ms) => new Date(ms + SHOP_OFFSET).toISOString().slice(0, 10);
const shopYear = (ms) => Number(shopDay(ms).slice(0, 4));
// A shop wall-clock time -> ms
const shopTime = (ymd, hh = 0, mm = 0) => Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) - SHOP_OFFSET;
const addDaysYmd = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
// Moves a time into shop hours (8:00-18:00); past closing -> next morning
const inShopHours = (ms, rnd) => {
  const local = new Date(ms + SHOP_OFFSET);
  const h = local.getUTCHours();
  if (h >= 8 && h < 18) return ms;
  const ymd = local.toISOString().slice(0, 10);
  const day = h < 8 ? ymd : addDaysYmd(ymd, 1);
  return shopTime(day, rnd.int(8, 10), rnd.int(0, 59));
};

// Prices and costs went up over the years: a 2025-2026 price times this factor
const PRICE_FACTOR = { 2020: 0.82, 2021: 0.85, 2022: 0.9, 2023: 0.94, 2024: 0.97, 2025: 1, 2026: 1 };
const factorFor = (year) => PRICE_FACTOR[year] || 1;
const pesos = (c) => Math.round(c) / 100;

// ---------------------------------------------------------------------------------------------
// The shop's world
// ---------------------------------------------------------------------------------------------
const SUPPLIERS = [
  { key: 'garments', supplier_name: 'Davao Garments Supply', contact_person: 'Rowena Ty', address: 'Ponciano Reyes St., Davao City', notes: 'Blank shirts and polos. Delivers on Tuesdays and Fridays.' },
  { key: 'jersey', supplier_name: 'Mindanao Sportswear Trading', contact_person: 'Jun Abellana', address: 'Bajada, Davao City', notes: 'Sublimation jersey blanks and shorts.' },
  { key: 'ink', supplier_name: 'PrintPro Ink & Media', contact_person: 'Carlo Mendoza', address: 'Lanang, Davao City', notes: 'Inks, transfer paper and DTF film. Pick-up or courier.' },
  { key: 'mug', supplier_name: 'Southland Ceramics & Gifts', contact_person: 'Liza Uy', address: 'Matina, Davao City', notes: 'Sublimation mugs and tote bags.' },
  { key: 'tarp', supplier_name: 'Agdao Tarp & Sticker Supply', contact_person: 'Ramil Dizon', address: 'Agdao, Davao City', notes: 'Tarpaulin rolls, vinyl and sticker paper.' },
  { key: 'pack', supplier_name: 'Bankerohan Packaging Center', contact_person: 'Grace Lim', address: 'Bankerohan, Davao City', notes: 'Plastic bags and boxes.' }
];

// base cost / price are 2025-2026 Davao pesos. print_pricing (migration 017): 'per_area' = price is the
// blank and each print area adds its charge (front A4, back A3...); 'included' = the finished piece
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];
const CATALOG = [
  ...SIZES.map((s) => ({ key: `wtee-${s}`, item_name: `White T-Shirt (${s})`, item_category: 'Apparel', unit: 'pcs', cost: s === '2XL' ? 105 : 95, price: s === '2XL' ? 175 : 160, print_pricing: 'per_area', has_sizes: true, requires_pressing: true, min: 30, supplier: 'garments', group: 'wtee', size: s })),
  ...['M', 'L', 'XL'].map((s) => ({ key: `btee-${s}`, item_name: `Black T-Shirt (${s})`, item_category: 'Apparel', unit: 'pcs', cost: 112, price: 180, print_pricing: 'per_area', has_sizes: true, requires_pressing: true, min: 20, supplier: 'garments', group: 'btee', size: s })),
  ...['S', 'M', 'L', 'XL'].map((s) => ({ key: `jersey-${s}`, item_name: `Sublimation Jersey Set (${s})`, item_category: 'Sportswear', unit: 'sets', cost: 265, price: 550, print_pricing: 'included', has_sizes: true, requires_pressing: false, min: 15, supplier: 'jersey', group: 'jersey', size: s })),
  ...['M', 'L', 'XL'].map((s) => ({ key: `polo-${s}`, item_name: `Polo Shirt (${s})`, item_category: 'Apparel', unit: 'pcs', cost: 185, price: 320, print_pricing: 'per_area', has_sizes: true, requires_pressing: false, min: 15, supplier: 'garments', group: 'polo', size: s })),
  { key: 'hoodie-L', item_name: 'Hoodie (L)', item_category: 'Apparel', unit: 'pcs', cost: 330, price: 550, print_pricing: 'per_area', has_sizes: true, requires_pressing: false, min: 8, supplier: 'garments', group: 'hoodie', size: 'L' },
  { key: 'mug', item_name: 'Sublimation Mug 11oz', item_category: 'Drinkware', unit: 'pcs', cost: 58, price: 180, print_pricing: 'included', has_sizes: false, requires_pressing: false, min: 30, supplier: 'mug', group: 'mug' },
  { key: 'tote', item_name: 'Canvas Tote Bag', item_category: 'Bags', unit: 'pcs', cost: 72, price: 110, print_pricing: 'per_area', has_sizes: false, requires_pressing: false, min: 20, supplier: 'mug', group: 'tote' },
  { key: 'lanyard', item_name: 'ID Lanyard (printed)', item_category: 'Accessories', unit: 'pcs', cost: 24, price: 80, print_pricing: 'included', has_sizes: false, requires_pressing: false, min: 50, supplier: 'tarp', group: 'lanyard' },
  { key: 'tarp', item_name: 'Tarpaulin (per sq ft)', item_category: 'Signage', unit: 'sq ft', cost: 9, price: 20, print_pricing: 'included', has_sizes: false, requires_pressing: false, min: 200, supplier: 'tarp', group: 'tarp' },
  { key: 'sticker', item_name: 'Vinyl Sticker Sheet (A4)', item_category: 'Signage', unit: 'sheets', cost: 19, price: 50, print_pricing: 'included', has_sizes: false, requires_pressing: false, min: 40, supplier: 'tarp', group: 'sticker' },
  // Consumables: taken by the usage rates, never sold on their own
  { key: 'ink', item_name: 'Sublimation Ink', item_category: 'Consumable', unit: 'ml', cost: 1.2, price: 0, has_sizes: false, requires_pressing: false, min: 1500, supplier: 'ink', consumable: true },
  { key: 'paper', item_name: 'Transfer Paper', item_category: 'Consumable', unit: 'sheets', cost: 6, price: 0, has_sizes: false, requires_pressing: false, min: 300, supplier: 'ink', consumable: true },
  { key: 'dtf', item_name: 'DTF Film (A3)', item_category: 'Consumable', unit: 'sheets', cost: 14, price: 0, has_sizes: false, requires_pressing: false, min: 200, supplier: 'ink', consumable: true },
  { key: 'bag', item_name: 'Packaging Plastic Bag', item_category: 'Consumable', unit: 'pcs', cost: 2, price: 0, has_sizes: false, requires_pressing: false, min: 300, supplier: 'pack', consumable: true }
];

// How much of each consumable ONE piece uses, and when it is taken (the Catalog's "Usage rates")
const RATES_BY_GROUP = {
  wtee: [['dtf', 1, 'Pressing'], ['ink', 6, 'Pressing'], ['bag', 1, 'Completed']],
  btee: [['dtf', 1, 'Pressing'], ['ink', 8, 'Pressing'], ['bag', 1, 'Completed']],
  jersey: [['ink', 28, 'Pressing'], ['paper', 3, 'Pressing'], ['bag', 1, 'Completed']],
  polo: [['dtf', 1, 'Pressing'], ['ink', 5, 'Pressing'], ['bag', 1, 'Completed']],
  hoodie: [['dtf', 2, 'Pressing'], ['ink', 10, 'Pressing'], ['bag', 1, 'Completed']],
  mug: [['ink', 3, 'Pressing'], ['paper', 1, 'Pressing']],
  tote: [['dtf', 1, 'Pressing'], ['ink', 4, 'Pressing']]
};

const FIRST_NAMES = ['Maria', 'Jose', 'Juan', 'Ana', 'Mark', 'Kristine', 'John Paul', 'Angelica', 'Christian', 'Jasmine', 'Rodel', 'Mary Grace', 'Jerome', 'Liezl', 'Ramon', 'Joy', 'Kevin', 'Princess', 'Ariel', 'Shiela', 'Noel', 'Camille', 'Reynaldo', 'Hazel', 'Dennis', 'Lovely', 'Arnel', 'Rhea', 'Jericho', 'Bea'];
const LAST_NAMES = ['Dela Cruz', 'Santos', 'Reyes', 'Garcia', 'Mendoza', 'Bautista', 'Villanueva', 'Fernandez', 'Cabrera', 'Torres', 'Navarro', 'Castillo', 'Aquino', 'Ramos', 'Flores', 'Gonzales', 'Lim', 'Tan', 'Uy', 'Sarmiento', 'Pascual', 'Dizon', 'Abellana', 'Lumapas', 'Sumalinog', 'Ybañez', 'Alcantara', 'Montemayor', 'Lagunzad', 'Tagalog'];
const PLACES = ['Agdao', 'Buhangin', 'Toril', 'Calinan', 'Mintal', 'Matina', 'Bajada', 'Lanang', 'Sasa', 'Bunawan', 'Talomo', 'Catalunan', 'Tibungco', 'Panacan', 'Ma-a', 'Ecoland', 'Bangkal', 'Indangan', 'Cabantian', 'Mandug'];
const SCHOOL_KINDS = ['National High School', 'Central Elementary School', 'Integrated School', 'National High School', 'Elementary School'];
const COMPANIES = ['Mabuhay Builders Corp.', 'Davao Agri-Ventures Inc.', 'Durian City Foods', 'Gulf Coast Logistics', 'Samal Island Resorts Co.', 'Bangkerohan Hardware', 'Lanang Dental Clinic', 'Matina Auto Care', 'Southern Mindanao Pharma', 'Island Garden Travel & Tours', 'Kadayawan Events Studio', 'Magsaysay Rice Trading'];
const ORGS = ['Davao Riders Club', 'Agdao Youth Council', 'Couples for Christ Buhangin', 'Davao Runners Group', 'Toril Basketball League', 'Mintal Seniors Association', 'Holy Cross Parish Youth', 'Davao Coffee Lovers Society', 'Matina Zumba Group', 'Lanang Badminton Club'];
const COMPANY_SUFFIX = ['Main Office', 'Warehouse', 'Branch'];

const userPicker = (users, rnd) => {
  const by = (roles) => users.filter((u) => roles.includes(u.role));
  const pool = (roles) => {
    const list = by(roles);
    return list.length ? list : users;
  };
  const owners = pool(['Owner']);
  const managers = pool(['Owner', 'Admin']);
  const workers = pool(['Staff', 'Production', 'Owner', 'Admin']);
  const production = pool(['Production', 'Staff']);
  const any = (list) => (list.length ? rnd.pick(list) : { user_id: null, role: null });
  return { owner: () => any(owners), manager: () => any(managers), worker: () => any(workers), production: () => any(production) };
};

// ---------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------
const generateHistory = ({ users = [], now = new Date(), start = START_DAY, seed = 20200101, ordersPerMonth = [20, 40] } = {}) => {
  const rnd = makeRandom(seed);
  const nowMs = now.getTime();
  const today = shopDay(nowMs);
  const who = userPicker(users, rnd);
  const T = {
    suppliers: [], inventory_items: [], consumable_rates: [], customers: [], customer_branches: [], order_profiles: [],
    order_items: [], order_print_details: [], order_status_history: [], order_consumables_log: [], payments: [],
    order_delivery_plans: [], order_deliveries: [], material_loss: [], overhead_expenses: [], stock_documents: [],
    stock_document_lines: [], stock_movements: []
  };

  // ---------- suppliers and catalog ----------
  const supplierByKey = new Map();
  for (const s of SUPPLIERS) {
    const row = {
      supplier_id: `SUP-${rnd.hex(8).toUpperCase()}`, supplier_name: s.supplier_name, contact_person: s.contact_person,
      contact_number: `09${rnd.digits(9)}`, email: `${s.supplier_name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`,
      address: s.address, notes: s.notes, created_at: utcText(shopTime(start, 8, 0)), sync_status: 'synced'
    };
    T.suppliers.push(row);
    supplierByKey.set(s.key, row);
  }
  const itemByKey = new Map();
  const startMs = shopTime(start, 7, 0);
  for (const c of CATALOG) {
    const supplier = supplierByKey.get(c.supplier);
    const item = {
      ...c,
      inventory_id: rnd.uuid(),
      supplier_row: supplier,
      onHand: 0,
      reserved: 0,
      costC: Math.round(c.cost * 100 * factorFor(shopYear(startMs))),
      target: c.min * 4
    };
    itemByKey.set(c.key, item);
  }
  const items = [...itemByKey.values()];
  const itemById = new Map(items.map((i) => [i.inventory_id, i]));
  for (const [group, list] of Object.entries(RATES_BY_GROUP)) {
    for (const product of items.filter((i) => i.group === group)) {
      for (const [consumable, rate, trigger] of list) {
        T.consumable_rates.push({
          rate_id: rnd.uuid(), product_inventory_id: product.inventory_id, consumable_inventory_id: itemByKey.get(consumable).inventory_id,
          quantity_per_piece: rate, trigger_status: trigger, sync_status: 'synced'
        });
      }
    }
  }
  const rates = T.consumable_rates;

  // ---------- stock (every change through here, in time order) ----------
  let lastStockMs = startMs;
  const movement = (item, delta, at, type, ref = {}) => {
    item.onHand += delta;
    if (item.onHand < 0 || item.reserved < 0 || item.onHand < item.reserved) {
      throw new Error(`Stock went wrong for ${item.item_name} at ${utcText(at)}: on hand ${item.onHand}, reserved ${item.reserved}`);
    }
    T.stock_movements.push({
      movement_id: rnd.uuid(), inventory_id: item.inventory_id, item_name: item.item_name, movement_type: type,
      quantity_change: delta, balance_after: item.onHand, unit_cost: pesos(ref.unit_costC !== undefined ? ref.unit_costC : item.costC),
      reference_type: ref.reference_type || null, reference_id: ref.reference_id || null, reference_no: ref.reference_no || null,
      note: ref.note || null, performed_by: ref.user ? ref.user.user_id : null, performed_role: ref.user ? ref.user.role : null,
      occurred_at: utcText(at), created_at: utcText(at), sync_status: 'synced'
    });
    lastStockMs = Math.max(lastStockMs, at);
  };

  const docNumbers = new Map(); // `${prefix}|${year}` -> last number
  const nextDocNo = (prefix, at) => {
    const year = shopYear(at);
    const key = `${prefix}|${year}`;
    const n = (docNumbers.get(key) || 0) + 1;
    docNumbers.set(key, n);
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
  };
  const stockDocument = (type, at, lines, extra = {}) => {
    const user = extra.user || who.worker();
    const document_id = rnd.uuid();
    const document_no = nextDocNo({ stock_in: 'SI', stock_out: 'SO', stock_count: 'SC' }[type], at);
    let totalC = 0;
    lines.forEach((l, i) => {
      // The document's value, as routes/stock.js saves it: stock in and out at the line's cost, a count
      // by how far it was off (stockDocuments.countResult's value_difference)
      totalC += type === 'stock_count' ? Math.abs(l.quantity - l.system_quantity) * l.unit_costC : l.quantity * l.unit_costC;
      T.stock_document_lines.push({
        line_id: rnd.uuid(), document_id, line_no: i + 1, inventory_id: l.item.inventory_id, item_name: l.item.item_name, unit: l.item.unit,
        quantity: l.quantity, system_quantity: l.system_quantity === undefined ? null : l.system_quantity, unit_cost: pesos(l.unit_costC)
      });
    });
    T.stock_documents.push({
      document_id, document_type: type, document_no, reason: extra.reason || null, supplier_id: extra.supplier ? extra.supplier.supplier_id : null,
      order_id: null, reference_type: extra.reference_type || null, reference_no: extra.reference_no || null, occurred_at: utcText(at),
      notes: extra.notes || null, total_cost: pesos(totalC), recorded_by: user.user_id, recorded_role: user.role, created_at: utcText(at)
    });
    return { document_id, document_no, user };
  };

  // A delivery from the item's supplier, with its other low items, just before `before`
  const restock = (item, needFree, before) => {
    const at = Math.max(lastStockMs + 60 * 1000, before - rnd.int(2, 30) * HOUR);
    const supplier = item.supplier_row;
    const year = shopYear(at);
    const wanted = [item, ...items.filter((x) => x !== item && x.supplier_row === supplier && x.onHand - x.reserved < x.min * 1.5)];
    const lines = wanted.map((x) => {
      const free = x.onHand - x.reserved;
      const need = x === item ? Math.max(needFree - free, 0) : 0;
      let quantity = Math.max(x.target - free, need + x.min * 2);
      const pack = x.unit === 'ml' ? 500 : x.min >= 100 ? 50 : 10;
      quantity = Math.ceil(quantity / pack) * pack;
      const unit_costC = Math.round(x.cost * 100 * factorFor(year) * (0.97 + rnd.next() * 0.06));
      return { item: x, quantity, unit_costC };
    });
    const ref = rnd.chance(0.6) ? 'Delivery receipt' : 'Sales invoice';
    const doc = stockDocument('stock_in', at, lines, {
      supplier, reference_type: ref, reference_no: `${ref === 'Delivery receipt' ? 'DR' : 'SI'}-${rnd.digits(5)}`,
      notes: rnd.chance(0.25) ? 'Checked and counted on arrival.' : null
    });
    for (const l of lines) {
      l.item.costC = averageAfterAddC({ onHand: l.item.onHand, costC: l.item.costC, addQty: l.quantity, addCostC: l.unit_costC });
      movement(l.item, l.quantity, at, 'stock_in', {
        reference_type: 'stock_document', reference_id: doc.document_id, reference_no: doc.document_no, unit_costC: l.unit_costC,
        note: `From ${supplier.supplier_name}`, user: doc.user
      });
    }
  };
  const ensureFree = (item, qty, at) => {
    if (item.onHand - item.reserved < qty) restock(item, qty, at);
  };

  // Opening stock when the shop started using the system
  for (const item of items) {
    movement(item, item.target, startMs, 'opening', { note: 'Opening balance when the shop started using the system' });
  }

  // ---------- clients ----------
  const customers = [];
  const newCustomer = (atMs) => {
    const kind = rnd.weighted([['School', 30], ['Individual', 38], ['Company', 14], ['Organization', 14], ['Government', 4]]);
    const first = rnd.pick(FIRST_NAMES);
    const last = rnd.pick(LAST_NAMES);
    const place = rnd.pick(PLACES);
    let full_name;
    if (kind === 'School') full_name = `${place} ${rnd.pick(SCHOOL_KINDS)}`;
    else if (kind === 'Company') full_name = rnd.pick(COMPANIES);
    else if (kind === 'Organization') full_name = rnd.pick(ORGS);
    else if (kind === 'Government') full_name = `Barangay ${place} Hall`;
    else full_name = `${first} ${last}`;
    if (customers.some((c) => c.full_name === full_name)) full_name = `${full_name} (${place})`;
    if (customers.some((c) => c.full_name === full_name)) full_name = `${first} ${last} ${rnd.pick(['Jr.', 'Sr.', 'II'])}`;
    const slug = full_name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const person = kind === 'Individual' ? null : `${rnd.pick(FIRST_NAMES)} ${rnd.pick(LAST_NAMES)}`;
    const c = {
      customer_id: `CUST-${rnd.hex(8).toUpperCase()}`, full_name, contact_number: `09${rnd.digits(9)}`,
      platform_source: rnd.weighted([['Facebook', 45], ['Walk-in', 25], ['Referral', 18], ['Messenger', 8], ['Instagram', 4]]),
      customer_type: kind, contact_person: person,
      email: kind === 'Individual' ? (rnd.chance(0.5) ? `${first.toLowerCase().replace(/\s/g, '')}.${last.toLowerCase().replace(/\s/g, '')}@example.com` : null) : `info@${slug.slice(0, 20)}.example.com`,
      address: kind === 'Individual' ? `${place}, Davao City` : `${rnd.pick(['Purok 3', 'J.P. Laurel Ave.', 'Quirino Ave.', 'Mac Arthur Hwy.', 'Km. 7', 'R. Castillo St.'])}, ${place}, Davao City`,
      social_media: rnd.chance(0.7) ? `facebook.com/${slug.slice(0, 30)}` : null,
      notes: kind === 'School' && rnd.chance(0.4) ? 'Orders for intramurals and graduation every year.' : null,
      contact_person_number: person ? `09${rnd.digits(9)}` : null,
      contact_person_email: person && rnd.chance(0.4) ? `${person.split(' ')[0].toLowerCase()}@example.com` : null,
      contact_person_social: person && rnd.chance(0.3) ? `facebook.com/${person.toLowerCase().replace(/[^a-z]+/g, '.')}` : null,
      sync_status: 'synced',
      branches: [],
      since: atMs
    };
    customers.push(c);
    if ((kind === 'Company' || kind === 'School') && rnd.chance(0.3)) {
      for (let b = 0; b < rnd.int(1, 2); b++) {
        const bplace = rnd.pick(PLACES.filter((p) => p !== place));
        c.branches.push({
          branch_id: `BR-${rnd.hex(8).toUpperCase()}`, customer_id: c.customer_id,
          branch_name: kind === 'School' ? `${bplace} Annex` : `${bplace} ${rnd.pick(COMPANY_SUFFIX)}`,
          address: `${rnd.pick(['Purok 1', 'National Hwy.', 'Diversion Rd.'])}, ${bplace}, Davao City`,
          contact_person: `${rnd.pick(FIRST_NAMES)} ${rnd.pick(LAST_NAMES)}`, contact_number: `09${rnd.digits(9)}`, email: null,
          notes: null, archived_at: null, archived_by: null, created_by: who.manager().user_id, created_at: utcText(atMs), sync_status: 'synced'
        });
      }
    }
    return c;
  };
  const chooseCustomer = (atMs) => {
    // Repeat clients become more likely as the shop grows
    if (customers.length > 8 && rnd.chance(Math.min(0.88, 0.45 + customers.length / 300))) {
      const regulars = customers.filter((c) => c.customer_type !== 'Individual');
      return rnd.chance(0.6) && regulars.length ? rnd.pick(regulars) : rnd.pick(customers);
    }
    return newCustomer(atMs);
  };

  // ---------- what a client orders ----------
  const sizeSplit = (total, sizes) => {
    const weights = { S: 12, M: 30, L: 32, XL: 18, '2XL': 8 };
    const w = sizes.map((s) => weights[s] || 10);
    const sum = w.reduce((a, b) => a + b, 0);
    const out = sizes.map((s, i) => ({ size: s, qty: Math.floor((total * w[i]) / sum) }));
    let left = total - out.reduce((a, b) => a + b.qty, 0);
    for (let i = 0; left > 0; i = (i + 1) % out.length, left--) out[i].qty++;
    return out.filter((x) => x.qty > 0);
  };
  const garmentLines = (group, total) => {
    const sizes = items.filter((i) => i.group === group).map((i) => i.size);
    return sizeSplit(total, sizes).map(({ size, qty }) => ({ item: itemByKey.get(`${group}-${size}`), quantity: qty }));
  };
  const orderLines = (c, month) => {
    const schoolSeason = [6, 7, 8, 2, 3].includes(month);
    const lines = [];
    let desc;
    switch (c.customer_type) {
      case 'School': {
        const kind = rnd.weighted([['shirts', schoolSeason ? 50 : 35], ['jerseys', schoolSeason ? 30 : 15], ['mugs', 10], ['tarp', 20], ['lanyards', 10]]);
        if (kind === 'shirts') {
          lines.push(...garmentLines(rnd.chance(0.8) ? 'wtee' : 'btee', rnd.int(4, 25) * 10));
          desc = rnd.pick(['Front: school logo, full colour. Back: "Intramurals" and the year.', 'Class shirts. Front: section name. Back: names of the students.', 'Faculty shirts for Teachers\' Day. Left chest logo, back print.', 'Graduation shirts. Front: batch name and year.']);
        } else if (kind === 'jerseys') {
          lines.push(...garmentLines('jersey', rnd.int(12, 30)));
          desc = 'Sublimation jerseys for the basketball team. Surname and number at the back, school name in front.';
        } else if (kind === 'mugs') {
          lines.push({ item: itemByKey.get('mug'), quantity: rnd.int(3, 12) * 10 });
          desc = 'Souvenir mugs with the school logo and event name.';
        } else if (kind === 'tarp') {
          lines.push({ item: itemByKey.get('tarp'), quantity: rnd.pick([24, 32, 48, 60, 96, 120]) });
          desc = rnd.pick(['Tarpaulin for the recognition day, 4 x 8 ft.', 'Moving-up ceremony backdrop tarpaulin.', 'Enrolment announcement tarpaulin.']);
        } else {
          lines.push({ item: itemByKey.get('lanyard'), quantity: rnd.int(5, 30) * 10 });
          desc = 'Printed ID lanyards with the school name.';
        }
        break;
      }
      case 'Company':
      case 'Government': {
        const kind = rnd.weighted([['polo', 40], ['mugs', 20], ['tote', 15], ['tarp', 15], ['hoodie', 10]]);
        if (kind === 'polo') lines.push(...garmentLines('polo', rnd.int(2, 8) * 10));
        else if (kind === 'mugs') lines.push({ item: itemByKey.get('mug'), quantity: rnd.int(2, 10) * 10 });
        else if (kind === 'tote') lines.push({ item: itemByKey.get('tote'), quantity: rnd.int(3, 15) * 10 });
        else if (kind === 'tarp') lines.push({ item: itemByKey.get('tarp'), quantity: rnd.pick([32, 48, 64, 96]) });
        else lines.push({ item: itemByKey.get('hoodie-L'), quantity: rnd.int(10, 30) });
        if (rnd.chance(0.25)) lines.push({ item: itemByKey.get('sticker'), quantity: rnd.int(2, 10) * 10 });
        desc = rnd.pick(['Company uniform. Embroidered-look logo on the left chest.', 'Giveaways for the anniversary. Logo and tagline.', 'Christmas party giveaways. Logo and "Merry Christmas" print.', 'Event signage and giveaways for the client launch.']);
        break;
      }
      case 'Organization': {
        const kind = rnd.weighted([['shirts', 55], ['jerseys', 20], ['lanyards', 10], ['mugs', 15]]);
        if (kind === 'shirts') lines.push(...garmentLines(rnd.chance(0.5) ? 'wtee' : 'btee', rnd.int(2, 10) * 10));
        else if (kind === 'jerseys') lines.push(...garmentLines('jersey', rnd.int(10, 24)));
        else if (kind === 'lanyards') lines.push({ item: itemByKey.get('lanyard'), quantity: rnd.int(3, 10) * 10 });
        else lines.push({ item: itemByKey.get('mug'), quantity: rnd.int(2, 6) * 10 });
        desc = rnd.pick(['Event shirts for the fun run. Route map at the back.', 'Team jerseys with names and numbers.', 'Members\' shirts. Club logo in front.', 'Outreach program giveaways.']);
        break;
      }
      default: {
        const kind = rnd.weighted([['shirt', 45], ['mug', 25], ['tarp', 15], ['sticker', 10], ['tote', 5]]);
        if (kind === 'shirt') {
          const group = rnd.chance(0.7) ? 'wtee' : 'btee';
          const sizes = items.filter((i) => i.group === group);
          const n = rnd.int(1, 3);
          for (let k = 0; k < n; k++) {
            const it = rnd.pick(sizes);
            const existing = lines.find((l) => l.item === it);
            if (existing) existing.quantity += rnd.int(1, 4);
            else lines.push({ item: it, quantity: rnd.int(1, 6) });
          }
          desc = rnd.pick(['Family reunion shirts. Same design for everyone.', 'Birthday shirt with photo print.', 'Couple shirts, matching design.', 'Barkada outing shirts with names at the back.']);
        } else if (kind === 'mug') {
          lines.push({ item: itemByKey.get('mug'), quantity: rnd.int(1, 12) });
          desc = rnd.pick(['Photo mug as a gift.', 'Mugs for a christening souvenir.', 'Personalised mug with name.']);
        } else if (kind === 'tarp') {
          lines.push({ item: itemByKey.get('tarp'), quantity: rnd.pick([12, 16, 24, 32]) });
          desc = rnd.pick(['Birthday tarpaulin, 3 x 4 ft.', 'Store signage tarpaulin.', 'Graduation tarpaulin with photo.']);
        } else if (kind === 'sticker') {
          lines.push({ item: itemByKey.get('sticker'), quantity: rnd.int(2, 20) });
          desc = 'Product label stickers for a small business.';
        } else {
          lines.push({ item: itemByKey.get('tote'), quantity: rnd.int(2, 15) });
          desc = 'Printed tote bags.';
        }
      }
    }
    return { lines, desc };
  };

  // ---------- the orders, month by month ----------
  const orders = [];
  const events = []; // stock-affecting events: { at, kind, order, ... }
  const [minPerMonth, maxPerMonth] = ordersPerMonth;
  const [sy, sm] = start.split('-').map(Number);
  const [ty, tm] = today.split('-').map(Number);
  for (let y = sy, m = sm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
    // Busier in school-opening, intramurals, graduation and Christmas months; slow in the 2020 lockdown
    const season = { 1: 0.35, 2: 0.6, 3: 0.75, 4: 0.3, 5: 0.35, 6: 0.85, 7: 0.8, 8: 0.85, 9: 0.5, 10: 0.55, 11: 0.75, 12: 0.95 }[m];
    let n = Math.round(minPerMonth + (maxPerMonth - minPerMonth) * Math.min(1, Math.max(0, season + (rnd.next() - 0.5) * 0.35)));
    if (y === 2020 && m >= 3 && m <= 6) n = minPerMonth;
    const lastDay = y === ty && m === tm ? Number(today.slice(8, 10)) : daysInMonth(y, m);
    if (y === ty && m === tm) n = Math.max(1, Math.round((n * lastDay) / daysInMonth(y, m)));
    for (let k = 0; k < n; k++) {
      const day = `${y}-${String(m).padStart(2, '0')}-${String(rnd.int(1, lastDay)).padStart(2, '0')}`;
      let created = shopTime(day, rnd.int(8, 17), rnd.int(0, 59));
      if (created > nowMs - 10 * 60 * 1000) created = nowMs - rnd.int(30, 600) * 60 * 1000;
      if (created < startMs + HOUR) created = startMs + HOUR;
      orders.push({ created, month: m });
    }
  }
  orders.sort((a, b) => a.created - b.created);

  const paymentsRaw = [];
  const handoverWho = (c) => c.contact_person || c.full_name;
  const statusRow = (order, from, to, at, user) => {
    T.order_status_history.push({
      history_id: rnd.uuid(), order_id: order.order_id, from_status: from, to_status: to,
      changed_by: user.user_id, changed_role: user.role, changed_at: utcText(at), sync_status: 'synced'
    });
  };

  for (const o of orders) {
    const c = chooseCustomer(o.created);
    const { lines, desc } = orderLines(c, o.month);
    const year = shopYear(o.created);
    const order_id = rnd.uuid();
    const creator = who.worker();
    const pieces = lines.reduce((s, l) => s + l.quantity, 0);
    const ageDays = (nowMs - o.created) / DAY;
    const branch = c.branches.length && rnd.chance(0.45) ? rnd.pick(c.branches) : null;

    // The design's print areas (migration 017): the same on every blank of the order
    const design = rnd.weighted([
      [[{ placement: 'Front', size: 'A4' }], 45],
      [[{ placement: 'Front', size: 'A4' }, { placement: 'Back', size: 'A3' }], 25],
      [[{ placement: 'Left chest', size: 'Small' }, { placement: 'Back', size: 'A3' }], 15],
      [[{ placement: 'Front', size: 'A3' }], 10],
      [[{ placement: 'Front', size: 'A4' }, { placement: 'Back', size: 'Name' }], 5]
    ]);
    for (const l of lines) l.print_areas = l.item.print_pricing === 'per_area' ? JSON.stringify(design) : null;

    // Quote: the catalog's price at that time, volume tiers, sometimes a layout fee or a discount
    const quoted = !(ageDays < 2 && rnd.chance(0.4));
    let quote = null;
    if (quoted) {
      const lineIds = lines.map(() => rnd.uuid());
      const result = computeQuote({
        items: lines.map((l, i) => ({
          line_item_id: lineIds[i], product_type: l.item.item_name, quantity: l.quantity, inventory_id: l.item.inventory_id,
          item_name: l.item.item_name, selling_price: Math.round(l.item.price * factorFor(year)),
          print_pricing: l.item.print_pricing || 'included', print_areas: l.print_areas
        })),
        requested: {
          ...(rnd.chance(0.3) ? { labor: rnd.pick([150, 200, 300, 500]) } : {}),
          ...(c.customer_type !== 'Individual' && rnd.chance(0.12)
            ? { percent: rnd.pick([3, 5]), reason: rnd.pick(['Loyal school customer', 'Repeat order', 'Partner organization']) }
            : {})
        }
      });
      if (result.problem) throw new Error(`Quote failed: ${JSON.stringify(result.problem.body)}`);
      quote = result.quote;
      quote.lineIds = lineIds;
    }
    const lineIds = quote ? quote.lineIds : lines.map(() => rnd.uuid());
    const totalC = quote ? Math.round(quote.total_quote_amount * 100) : 0;

    // The order's life. Times are planned first, then cut at "now".
    const needsPressing = lines.some((l) => l.item.requires_pressing);
    const cancel = quoted && rnd.chance(0.06);
    const delayed = !cancel && rnd.chance(0.04);
    const deadlineDay = addDaysYmd(shopDay(o.created), rnd.int(7, 21) + (pieces > 150 ? 7 : 0));
    const plan = {};
    // Most pay the downpayment the same day; some take a few days (the order waits as Pending)
    plan.dp = quoted ? inShopHours(o.created + (rnd.chance(0.6) ? rnd.int(0, 6) : rnd.int(20, 96)) * HOUR, rnd) : null;
    let t = Math.max(o.created, plan.dp || o.created);
    if (delayed) {
      plan.resume = inShopHours(t + rnd.int(2, 6) * DAY, rnd);
      t = plan.resume;
    }
    if (quoted) {
      // The work is spread up to the deadline: printing starts once the design is final, the
      // pieces are ready a day or two before, and most are picked up near the deadline
      plan.approve = inShopHours(t + rnd.int(1, 30) * HOUR, rnd);
      const due = shopTime(deadlineDay, 17, 0);
      const window = Math.max(2 * DAY, due - plan.approve);
      plan.printing = inShopHours(plan.approve + window * (0.15 + rnd.next() * 0.35), rnd);
      plan.pressing = needsPressing ? inShopHours(plan.printing + Math.max(4 * HOUR, window * (0.1 + rnd.next() * 0.15)), rnd) : null;
      plan.ready = inShopHours((plan.pressing || plan.printing) + Math.max(3 * HOUR, window * (0.1 + rnd.next() * 0.15)), rnd);
      const late = rnd.chance(0.1);
      plan.done = late
        ? inShopHours(Math.max(plan.ready, due) + rnd.int(4, 72) * HOUR, rnd)
        : inShopHours(Math.max(plan.ready + 2 * HOUR, due - rnd.int(0, 72) * HOUR), rnd);
    }
    if (cancel) {
      const early = rnd.chance(0.6);
      plan.cancel = early
        ? inShopHours(Math.max(o.created, plan.dp) + rnd.int(6, 72) * HOUR, rnd)
        : inShopHours(plan.printing + rnd.int(2, 24) * HOUR, rnd);
      if (early) { plan.approve = null; plan.printing = null; }
      plan.pressing = null; plan.ready = null; plan.done = null;
    }
    const happened = (at) => at !== null && at !== undefined && at <= nowMs - 5 * 60 * 1000;

    let status = delayed ? 'Delayed' : 'Pending';
    const history = [];
    if (delayed && happened(plan.resume)) { history.push(['Delayed', 'Pending', plan.resume, who.worker()]); status = 'Pending'; }
    const approver = who.manager();
    if (happened(plan.approve)) { history.push([status, 'Approved', plan.approve, approver]); status = 'Approved'; }
    if (happened(plan.printing)) { history.push([status, 'Printing', plan.printing, who.production()]); status = 'Printing'; }
    // migration 019: pressing is part of the production step (counted per item), not a status
    const pressingStarted = status === 'Printing' && happened(plan.pressing);
    if (happened(plan.ready)) { history.push([status, 'Ready', plan.ready, who.production()]); status = 'Ready'; }
    const cancelled = cancel && happened(plan.cancel);
    if (cancelled) { history.push([status, 'Cancelled', plan.cancel, who.owner()]); status = 'Cancelled'; }

    // Delivery batches for big orders of schools and organizations
    const batched = !cancel && pieces >= 120 && ['School', 'Organization', 'Company'].includes(c.customer_type) && rnd.chance(0.7);
    const deliveries = [];
    const plans = [];
    if (quoted && !cancel) {
      if (batched) {
        const n = pieces >= 200 ? 3 : 2;
        let left = pieces;
        for (let b = 1; b <= n; b++) {
          const qty = b === n ? left : Math.round(pieces / n);
          left -= qty;
          const readyAt = b === n ? plan.ready : Math.min(inShopHours(plan.printing + ((plan.ready - plan.printing) * b) / n, rnd), plan.ready);
          const deliveredAt = b === n ? plan.done : Math.max(readyAt, Math.min(inShopHours(readyAt + rnd.int(2, 36) * HOUR, rnd), plan.done - HOUR));
          plans.push({ b, qty, readyAt, deliveredAt, plannedDay: addDaysYmd(deadlineDay, b - n) });
        }
      } else {
        plans.length = 0;
      }
      // The completion is the last hand-over
      if (happened(plan.done) && (!batched || happened(plans[plans.length - 1].deliveredAt))) {
        history.push([status, 'Completed', plan.done, who.worker()]); status = 'Completed';
      }
    }

    // Payments: the downpayment (at least half), and the rest at the hand-over
    const pays = [];
    let cancelInfo = null;
    const cancelledFrom = cancelled ? history[history.length - 1][0] : null;
    if (quoted && happened(plan.dp)) {
      const half = Math.ceil(totalC / 2);
      const style = rnd.weighted([['half', 60], ['full', 25], ['more', 15]]);
      let dpC = style === 'full' ? totalC : style === 'more' ? Math.ceil((totalC * rnd.int(60, 80)) / 100) : half;
      dpC = Math.min(totalC, Math.ceil(dpC / 5000) * 5000 >= half ? Math.ceil(dpC / 5000) * 5000 : dpC);
      if (dpC < half) dpC = half;
      pays.push({ at: plan.dp, amountC: dpC, kind: 'dp' });
      if (status === 'Completed' && dpC < totalC) pays.push({ at: plan.done, amountC: totalC - dpC, kind: 'final' });
      else if (status === 'Ready' && dpC < totalC && rnd.chance(0.3)) {
        const partC = Math.min(totalC - dpC, Math.ceil((totalC - dpC) / 2 / 100) * 100);
        if (partC > 0) pays.push({ at: Math.min(nowMs - HOUR, plan.ready + rnd.int(1, 20) * HOUR), amountC: partC, kind: 'part' });
      }
      if (cancelled) {
        // migration 017: the cancellation fee of the stage; most clients get the suggested refund
        cancelInfo = cancellationTerms({ status: cancelledFrom, bill: pesos(totalC), paidNet: pesos(dpC) });
        const refundC = Math.round(cancelInfo.suggested_refund * 100);
        if (refundC > 0 && rnd.chance(0.85)) pays.push({ at: inShopHours(plan.cancel + rnd.int(1, 48) * HOUR, rnd), amountC: -refundC, kind: 'refund' });
      }
    }

    // ---------- rows ----------
    const lastAt = Math.max(o.created, ...history.map((h) => h[2]), ...pays.map((p) => p.at));
    const quoteParts = quote
      ? {
          subtotal_amount: quote.subtotal_amount, labor_amount: quote.labor_amount, incidental_amount: quote.incidental_amount,
          discount_amount: quote.discount_amount, discount_reason: quote.discount_reason
        }
      : { subtotal_amount: 0, labor_amount: 0, incidental_amount: 0, discount_amount: 0, discount_reason: null };
    const approvedRow = history.find((h) => h[1] === 'Approved');
    const lastEditor = history.length ? history[history.length - 1][3] : creator;
    const reservedNow = !['Completed', 'Cancelled'].includes(status) && status !== 'Delayed' && !(delayed && !happened(plan.resume));
    const order = {
      order_id, customer_id: c.customer_id, date_created: utcText(o.created), production_deadline: `${deadlineDay} 00:00:00`,
      production_status: status, design_drive_link: rnd.chance(0.35) ? `https://drive.google.com/file/d/1${rnd.hex(32)}/view` : null,
      total_quote_amount: pesos(totalC), stock_reserved: reservedNow, approved_by: approvedRow ? approvedRow[3].user_id : null,
      approved_at: approvedRow ? utcText(approvedRow[2]) : null, tracking_no: null, last_edited_by: lastEditor.user_id,
      last_edited_role: lastEditor.role, ...quoteParts,
      cancellation_fee: cancelled ? (cancelInfo ? cancelInfo.fee : 0) : null, cancelled_stage: cancelledFrom, cancel_shop_fault: false,
      client_delay_reason: null,
      cancellation_reason: cancelled ? rnd.pick(['Event was cancelled', 'Client found a cheaper supplier', 'Budget was not approved', 'Client changed the design too late']) : null,
      archived_at: null, archived_by: null, order_description: desc, adjustment_amount: 0, adjustment_reason: null,
      branch_id: branch ? branch.branch_id : null, sync_status: 'synced', last_modified: utcText(lastAt)
    };
    T.order_profiles.push(order);
    lines.forEach((l, i) => {
      const priced = quote ? quote.lines.find((q) => q.line_item_id === lineIds[i]) : null;
      T.order_items.push({
        line_item_id: lineIds[i], order_id, inventory_id: l.item.inventory_id, product_type: l.item.item_name.slice(0, 100),
        quantity: l.quantity, size: null, custom_name: null, custom_number: null, price: priced ? priced.unit_price : 0,
        print_areas: l.print_areas, qty_printed: 0, qty_pressed: 0, added_after_approval: false,
        unit_cost: null, sync_status: 'synced', _item: l.item, _order: order
      });
    });
    for (const [from, to, at, user] of history) statusRow(order, from, to, at, user);

    // Print details: a roster for jerseys, sizes for shirt orders
    const jerseyLines = lines.map((l, i) => ({ ...l, id: lineIds[i] })).filter((l) => l.item.group === 'jersey');
    if (jerseyLines.length && rnd.chance(0.8)) {
      let number = rnd.int(1, 5);
      for (const jl of jerseyLines) {
        for (let k = 0; k < jl.quantity; k++) {
          T.order_print_details.push({
            print_detail_id: rnd.uuid(), order_id, line_item_id: jl.id, print_type: 'Jersey print', quantity: 1, size: jl.item.size,
            custom_name: rnd.pick(LAST_NAMES).toUpperCase(), custom_number: String(number), notes: null, created_by: creator.user_id,
            created_at: utcText(o.created + HOUR), sync_status: 'synced'
          });
          number += rnd.int(1, 3);
        }
      }
    } else if (lines.some((l) => l.item.has_sizes) && rnd.chance(0.5)) {
      lines.forEach((l, i) => {
        if (!l.item.has_sizes) return;
        T.order_print_details.push({
          print_detail_id: rnd.uuid(), order_id, line_item_id: lineIds[i], print_type: 'Front & back print', quantity: l.quantity,
          size: l.item.size, custom_name: null, custom_number: null, notes: rnd.chance(0.3) ? 'Logo 10 in wide' : null,
          created_by: creator.user_id, created_at: utcText(o.created + HOUR), sync_status: 'synced'
        });
      });
    }

    // Planned batches and hand-overs
    let handoverNo = 0;
    for (const p of plans) {
      if (!happened(plan.approve)) break;
      const plan_id = rnd.uuid();
      const ready = happened(p.readyAt) && ['Printing', 'Pressing', 'Ready', 'Completed'].includes(status) ? p.readyAt : null;
      T.order_delivery_plans.push({
        plan_id, order_id, batch_no: p.b, planned_quantity: p.qty, planned_date: p.plannedDay, ready_at: ready ? utcText(ready) : null,
        ready_by: ready ? who.production().user_id : null, notes: p.b === 1 ? 'First sections / teams first' : null,
        created_by: creator.user_id, created_at: utcText(plan.approve), sync_status: 'synced'
      });
      if (ready && happened(p.deliveredAt) && p.deliveredAt >= ready) {
        handoverNo += 1;
        deliveries.push({ at: p.deliveredAt, qty: p.qty, plan_id, batch_no: handoverNo });
      }
    }
    if (!batched && status === 'Completed') deliveries.push({ at: plan.done, qty: pieces, plan_id: null, batch_no: 1, auto: true });
    for (const d of deliveries) {
      T.order_deliveries.push({
        delivery_id: rnd.uuid(), order_id, batch_no: d.batch_no, quantity: d.qty, delivered_at: utcText(d.at),
        method: rnd.weighted([['Pick-up', 70], ['Delivery', 20], ['Courier', 10]]), received_by_name: handoverWho(c),
        notes: d.auto ? 'Handed over when the order was completed' : null, recorded_by: who.worker().user_id, created_at: utcText(d.at),
        plan_id: d.plan_id, sync_status: 'synced'
      });
    }

    // Production progress (migration 017): what each status means, and never fewer pieces ready
    // than were already handed over
    {
      const mine = T.order_items.filter((r) => r._order === order && !r._item.consumable);
      const total = mine.reduce((s, r) => s + r.quantity, 0);
      const delivered = deliveries.reduce((s, d) => s + d.qty, 0);
      const fill = (rows, n, key) => {
        let left = n;
        for (const r of rows) { const k = Math.min(r.quantity, left); r[key] = k; left -= k; }
      };
      const done = ['Ready', 'Completed'].includes(status) || (status === 'Cancelled' && cancelledFrom === 'Ready');
      if (done || pressingStarted) fill(mine, total, 'qty_printed');
      else if (status === 'Printing' || (status === 'Cancelled' && cancelledFrom === 'Printing')) {
        fill(mine, Math.max(delivered, Math.round(total * (0.2 + rnd.next() * 0.6))), 'qty_printed');
      }
      const press = mine.filter((r) => r._item.requires_pressing);
      for (const r of mine) {
        if (!r._item.requires_pressing) continue;
        r.qty_pressed = done ? r.qty_printed : pressingStarted ? Math.round(r.qty_printed * rnd.next() * 0.8) : 0;
      }
      // pieces handed over were ready: printed (and pressed where needed)
      if (!done && delivered > 0) {
        const ready = mine.reduce((s, r) => s + (r._item.requires_pressing ? r.qty_pressed : r.qty_printed), 0);
        let short = Math.max(0, delivered - ready);
        for (const r of press) { const k = Math.min(r.qty_printed - r.qty_pressed, short); r.qty_pressed += k; short -= k; }
      }
    }

    // Payments (numbers are given later, in date order)
    for (const p of pays) {
      const method = p.kind === 'refund' ? null : rnd.weighted([
        ['Cash', year <= 2021 ? 55 : 38], ['GCash', year <= 2021 ? 30 : 42], ['Bank Transfer', 12], ['Maya', year >= 2022 ? 6 : 1], ['Cheque', c.customer_type === 'Company' ? 4 : 0]
      ]);
      paymentsRaw.push({ order, customer: c, ...p, method });
    }

    // Stock-affecting events of this order
    const reserveAt = delayed ? (happened(plan.resume) ? plan.resume : null) : o.created;
    if (reserveAt !== null && !(cancelled && plan.cancel <= reserveAt)) events.push({ at: reserveAt, kind: 'reserve', order, lines });
    if (cancelled && reserveAt !== null && plan.cancel > reserveAt) events.push({ at: plan.cancel, kind: 'release', order, lines });
    const steps = history.map(([from, to, at]) => ({ from, to, at }));
    for (const s of steps) {
      const triggers = triggersFor(s.from, s.to);
      if (triggers.length) events.push({ at: s.at, kind: 'consumables', order, lines, triggers, step: s.to });
      if (s.to === 'Completed') events.push({ at: s.at, kind: 'consume', order, lines });
    }
    // A misprint now and then, while it is being printed or pressed
    if (happened(plan.printing) && rnd.chance(0.11)) {
      const blanks = lines.filter((l) => !l.item.consumable && l.item.group !== 'tarp');
      if (blanks.length) {
        const l = rnd.pick(blanks);
        const end = Math.min(nowMs - HOUR, plan.ready || plan.pressing || nowMs - HOUR);
        const at = Math.max(plan.printing + HOUR, Math.min(end, plan.printing + rnd.int(1, 20) * HOUR));
        const code = l.item.requires_pressing && plan.pressing && at >= plan.pressing
          ? rnd.weighted([['heat_press_scorch', 50], ['misprint_alignment', 30], ['supplier_defect', 20]])
          : rnd.weighted([['misprint_alignment', 35], ['printer_head_banding', 25], ['sizing_encoding_error', 20], ['supplier_defect', 20]]);
        const stage = plan.pressing && at >= plan.pressing ? 'Pressing' : 'Printing';
        const tag = T.order_print_details.filter((p) => p.order_id === order_id && p.line_item_id === lineIds[lines.indexOf(l)]);
        events.push({
          at, kind: 'loss', order, item: l.item, qty: Math.max(1, Math.min(rnd.int(1, 4), Math.ceil(l.quantity * 0.05))), code, stage,
          print_detail_id: tag.length && code === 'sizing_encoding_error' ? rnd.pick(tag).print_detail_id : null
        });
      }
    }
  }

  // ---------- shop events that are not orders ----------
  for (let y = sy; y <= ty; y++) {
    for (let m = 1; m <= 12; m++) {
      const first = `${y}-${String(m).padStart(2, '0')}-01`;
      if (first < start.slice(0, 7) + '-01' || first > today) continue;
      const day = (d) => `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`;
      const at = (d, h) => shopTime(day(d), h, rnd.int(0, 59));
      const okDay = (d) => day(d) <= today;
      // Shop use and samples
      if (rnd.chance(0.35) && okDay(18)) {
        const it = rnd.pick(items.filter((i) => ['wtee', 'mug', 'tote'].includes(i.group)));
        events.push({ at: at(rnd.int(10, 18), 15), kind: 'stock_out', item: it, qty: rnd.int(1, 3), reason: rnd.pick(['Used in the shop (not for an order)', 'Given as a sample or freebie']) });
      }
      // Damaged in storage (no order)
      if (rnd.chance(0.15) && okDay(25)) {
        const it = rnd.pick(items.filter((i) => !i.consumable));
        events.push({ at: at(rnd.int(20, 25), 16), kind: 'loss', order: null, item: it, qty: rnd.int(1, 3), code: 'damaged_in_storage', stage: null });
      }
      // Yearly count on the second Saturday-ish of January
      if (m === 1 && okDay(11) && y > sy) events.push({ at: at(11, 9), kind: 'count' });
    }
  }

  // ---------- run the stock, in time order ----------
  events.sort((a, b) => a.at - b.at);
  const done = new Map(); // order_id -> [{ trigger_status, consumable_inventory_id }]
  const itemsOf = (lines) => lines.map((l) => ({ inventory_id: l.item.inventory_id, quantity: l.quantity }));
  for (const e of events) {
    const at = Math.max(e.at, lastStockMs + 1000);
    if (e.kind === 'reserve') {
      for (const l of e.lines) {
        ensureFree(l.item, l.quantity, at);
        l.item.reserved += l.quantity;
      }
    } else if (e.kind === 'release') {
      for (const l of e.lines) l.item.reserved -= l.quantity;
    } else if (e.kind === 'consumables') {
      const planned = plannedDeductions({ items: itemsOf(e.lines), rates, triggers: e.triggers, done: done.get(e.order.order_id) || [] });
      for (const p of planned) {
        const item = itemById.get(p.consumable_inventory_id);
        if (item.onHand - item.reserved < p.needed) restock(item, p.needed, at);
        const t2 = Math.max(at, lastStockMs + 1000);
        T.order_consumables_log.push({
          log_id: rnd.uuid(), order_id: e.order.order_id, trigger_status: p.trigger_status, consumable_inventory_id: item.inventory_id,
          quantity_deducted: p.needed, shortfall: 0, deducted_at: utcText(t2), unit_cost: pesos(item.costC), sync_status: 'synced'
        });
        movement(item, -p.needed, t2, 'consumables_used', {
          reference_type: 'order', reference_id: e.order.order_id, reference_no: e.order.order_id, note: `${p.trigger_status} step`
        });
        done.set(e.order.order_id, [...(done.get(e.order.order_id) || []), { trigger_status: p.trigger_status, consumable_inventory_id: item.inventory_id }]);
      }
    } else if (e.kind === 'consume') {
      for (const l of e.lines) {
        l.item.reserved -= l.quantity;
        movement(l.item, -l.quantity, at, 'order_used', { reference_type: 'order', reference_id: e.order.order_id, reference_no: e.order.order_id, note: 'Order completed' });
      }
      for (const row of T.order_items.filter((r) => r._order === e.order)) row.unit_cost = pesos(row._item.costC);
    } else if (e.kind === 'loss') {
      const item = e.item;
      if (item.onHand - item.reserved < e.qty) restock(item, e.qty, at);
      const t2 = Math.max(at, lastStockMs + 1000);
      const loss_id = rnd.uuid();
      const reason = REASON_CODES[e.code];
      T.material_loss.push({
        loss_id, order_id: e.order ? e.order.order_id : null, inventory_id: item.inventory_id, quantity_lost: e.qty,
        loss_reason: reason.label, date_recorded: utcText(t2), financial_cost: pesos(item.costC * e.qty), reason_code: e.code,
        loss_category: reason.category, production_stage: e.stage, is_statistical_anomaly: false, loss_batch_id: null,
        print_detail_id: e.print_detail_id || null, sync_status: 'synced'
      });
      movement(item, -e.qty, t2, 'loss', {
        reference_type: 'material_loss', reference_id: loss_id, reference_no: e.order ? e.order.order_id : null, note: reason.label, user: who.production()
      });
    } else if (e.kind === 'stock_out') {
      const item = e.item;
      if (item.onHand - item.reserved < e.qty) restock(item, e.qty, at);
      const t2 = Math.max(at, lastStockMs + 1000);
      const doc = stockDocument('stock_out', t2, [{ item, quantity: e.qty, unit_costC: item.costC }], { reason: e.reason });
      movement(item, -e.qty, t2, 'stock_out', {
        reference_type: 'stock_document', reference_id: doc.document_id, reference_no: doc.document_no, note: e.reason, user: doc.user
      });
    } else if (e.kind === 'count') {
      // Counted on the shelf: most items match, a few are off by one or two
      const lines = items.map((item) => {
        let counted = item.onHand;
        if (rnd.chance(0.15) && !item.consumable) counted = Math.max(item.reserved, item.onHand + rnd.pick([-2, -1, 1]));
        return { item, quantity: counted, system_quantity: item.onHand, unit_costC: item.costC };
      });
      const doc = stockDocument('stock_count', at, lines, { reason: 'Yearly stock count', notes: 'Counted at the start of the year.', user: who.manager() });
      for (const l of lines) {
        if (l.quantity !== l.system_quantity) {
          movement(l.item, l.quantity - l.system_quantity, at, 'count', {
            reference_type: 'stock_document', reference_id: doc.document_id, reference_no: doc.document_no, note: 'Yearly stock count', user: doc.user
          });
        }
      }
    }
  }

  // ---------- numbers, in date order (like the database triggers) ----------
  const orderCounters = new Map();
  for (const order of T.order_profiles) {
    const y = shopYear(Date.parse(`${order.date_created.replace(' ', 'T')}Z`));
    const n = (orderCounters.get(y) || 0) + 1;
    orderCounters.set(y, n);
    order.tracking_no = `XM-${y}-${String(n).padStart(4, '0')}`;
  }
  const trackingById = new Map(T.order_profiles.map((o) => [o.order_id, o.tracking_no]));
  for (const m of T.stock_movements) if (m.reference_type === 'order' || m.reference_type === 'material_loss') m.reference_no = trackingById.get(m.reference_no) || null;

  paymentsRaw.sort((a, b) => a.at - b.at);
  const receiptCounters = new Map();
  for (const p of paymentsRaw) {
    const y = shopYear(p.at);
    const n = (receiptCounters.get(y) || 0) + 1;
    receiptCounters.set(y, n);
    const refund = p.kind === 'refund';
    const method = refund ? (paymentsRaw.find((q) => q.order === p.order && q.kind === 'dp') || {}).method || 'Cash' : p.method;
    const nonCash = method !== 'Cash';
    const verifier = who.manager();
    T.payments.push({
      payment_id: rnd.uuid(), order_id: p.order.order_id, amount: pesos(p.amountC), payment_date: utcText(p.at), payment_type: method,
      received_by: who.worker().user_id, receipt_no: `AR-${y}-${String(n).padStart(4, '0')}`, voids_payment_id: null, void_reason: null,
      payer_name: !refund && p.customer.contact_person && rnd.chance(0.5) ? p.customer.contact_person : null,
      reference_no: method === 'GCash' ? rnd.digits(13) : method === 'Maya' ? rnd.digits(12) : method === 'Bank Transfer' ? `FT${rnd.digits(10)}` : null,
      bank_name: method === 'Bank Transfer' || method === 'Cheque' ? rnd.pick(['BDO', 'BPI', 'Landbank', 'Metrobank', 'Security Bank']) : null,
      account_name: method === 'GCash' || method === 'Maya' || method === 'Bank Transfer' ? (p.customer.contact_person || p.customer.full_name) : null,
      cheque_no: method === 'Cheque' ? rnd.digits(8) : null, cheque_date: method === 'Cheque' ? shopDay(p.at) : null,
      payment_notes: p.kind === 'dp' ? 'Downpayment' : p.kind === 'final' ? 'Full payment on pick-up' : p.kind === 'part' ? 'Partial payment' : null,
      is_refund: refund, refund_reason: refund ? 'Order cancelled' : null,
      verified_by: nonCash && !refund ? verifier.user_id : null, verified_at: nonCash && !refund ? utcText(Math.min(nowMs, p.at + rnd.int(1, 20) * HOUR)) : null,
      recorded_at: utcText(p.at + rnd.int(0, 10) * 60 * 1000), sync_status: 'synced'
    });
  }

  // ---------- overheads, every month ----------
  const firstMonth = start.slice(0, 7);
  for (let y = sy; y <= ty; y++) {
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      if (ym < firstMonth || ym > today.slice(0, 7)) continue;
      const f = factorFor(y);
      const add = (d, category, description, amount) => {
        const ymd = `${ym}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`;
        if (ymd > today) return;
        T.overhead_expenses.push({
          expense_id: rnd.uuid(), expense_date: `${ymd} 00:00:00`, category, description, amount: Math.round(amount * 100) / 100,
          recorded_by: who.manager().user_id, sync_status: 'synced'
        });
      };
      add(5, 'Rent', 'Shop rent', Math.round(15000 * f / 100) * 100);
      add(12, 'Electricity & Utilities', 'Davao Light bill', Math.round((5200 + ([4, 5].includes(m) ? 1800 : 0) + rnd.int(-500, 900)) * f));
      add(14, 'Electricity & Utilities', 'Water bill (DCWD)', Math.round((650 + rnd.int(-80, 120)) * f));
      add(8, 'Other', 'Internet (fiber plan)', y <= 2021 ? 1699 : 1899);
      add(15, 'Salaries & Wages', 'Staff wages, 1st half', Math.round(12000 * f / 100) * 100);
      add(30, 'Salaries & Wages', 'Staff wages, 2nd half', Math.round(12000 * f / 100) * 100);
      if (rnd.chance(0.25)) add(rnd.int(3, 27), 'Equipment Maintenance', rnd.pick(['Printer head cleaning and parts', 'Heat press repair', 'Cutter blade replacement', 'Aircon cleaning']), Math.round(rnd.int(1500, 6500) * f));
      if (rnd.chance(0.1)) add(rnd.int(3, 27), 'Outsourced Printing / Embroidery', 'Embroidery outsourced for a company uniform order', Math.round(rnd.int(2500, 9000) * f));
    }
  }

  // ---------- the catalog as it stands now ----------
  for (const item of items) {
    T.inventory_items.push({
      inventory_id: item.inventory_id, item_name: item.item_name, item_category: item.item_category, quantity_available: item.onHand,
      quantity_reserved: item.reserved, minimum_threshold: item.min, unit_cost: pesos(item.costC), unit: item.unit,
      supplier: item.supplier_row.supplier_name, supplier_id: item.supplier_row.supplier_id, selling_price: item.price,
      has_sizes: item.has_sizes, requires_pressing: item.requires_pressing, print_pricing: item.print_pricing || 'included',
      deleted_at: null, deleted_by: null, purged_at: null,
      sync_status: 'synced'
    });
  }
  for (const c of customers) {
    T.customer_branches.push(...c.branches);
    const { branches, since, ...row } = c;
    T.customers.push(row);
  }
  for (const r of T.order_items) {
    delete r._item;
    delete r._order;
  }

  const documentCounters = [...docNumbers].map(([key, last_number]) => {
    const [prefix, year] = key.split('|');
    return { prefix, year: Number(year), last_number };
  });
  const summary = {
    from: start, to: today,
    orders: T.order_profiles.length,
    by_status: T.order_profiles.reduce((m, o) => ({ ...m, [o.production_status]: (m[o.production_status] || 0) + 1 }), {}),
    customers: T.customers.length, branches: T.customer_branches.length, items: T.inventory_items.length, suppliers: T.suppliers.length,
    payments: T.payments.length, stock_documents: T.stock_documents.length, waste_records: T.material_loss.length,
    overheads: T.overhead_expenses.length, stock_movements: T.stock_movements.length
  };
  return {
    tables: T,
    counters: {
      orders: [...orderCounters].map(([year, last_number]) => ({ year, last_number })),
      receipts: [...receiptCounters].map(([year, last_number]) => ({ year, last_number })),
      documents: documentCounters
    },
    summary
  };
};

module.exports = { generateHistory, START_DAY, CATALOG, SUPPLIERS };
