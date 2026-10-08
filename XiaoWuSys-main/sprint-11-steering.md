# XiaoWuSys Sprint 11: Approve Job Order & Reserve Blank Stock (PB 13)

> Master context for a new AI session. Read this file completely before changing any code.
> Repository: `EnriMiguelCostan/XiaoWuSys`. App root: `XiaoWuSys-main/` (`Backend/` and `Frontend/`).

## 0. Ground rules for this session
- **Read before you write.** Open `routes/orders.js`, `routes/inventory.js`, `services/records.js`, `services/sync.js`, `services/capacity.js`, `services/inventoryEvents.js`, `utils/validation.js`, `utils/dbErrors.js` and `schema.sql` before you design anything. Reuse what is already there instead of re-implementing it.
- **Do not weaken existing guarantees** (§1). Every new route must go through validation, `sendDbError`, connection-only fallback (C5) and the global JSON error handler.
- **Styling:** use React **inline styles only**, matching `App.jsx` and `InventoryCatalog.jsx`. Do **not** add Tailwind or any CSS framework.
- **Schema changes** go into a new numbered file in `Backend/migrations/` (next is `004_...sql`). It must be idempotent (`IF NOT EXISTS`). Mirror any change in `initLocalDb.js` for SQLite. Never edit migrations that have already been applied.
- **Git:** create a new branch off `main`. Do not commit to `main`. Open a PR through the GitHub REST API.
- **Naming:** the database and API use **snake_case** (`quantity_available`, `quantity_reserved`). Where the backlog says `quantityAvailable` / `quantityReserved`, it means these columns.

---

## 1. Current architectural state (end of Sprint 10 / audit fixes)

### Stack
- **Backend:** Node.js 22, Express 5, `pg`, `sqlite3`, Socket.io 4, `jsonwebtoken`, `bcrypt`. Entry point: `Backend/server.js`.
- **Databases:** **Neon PostgreSQL** is the source of truth. **SQLite** (`Backend/local_cache.db`) is the offline cache.
- **Frontend:** React 19 + Vite. `src/App.jsx` (login, Create Order, Analytics) and `src/InventoryCatalog.jsx`. `socket.io-client` 4.

### Unified schema
- `Backend/schema.sql` is for a fresh Neon database. `Backend/migrations/` is applied with `npm run migrate`, which tracks progress in `schema_migrations`:
  - `001` installs the `last_modified` trigger.
  - `002` aligns a legacy Neon database (adds missing columns, `order_items.inventory_id` and its FK).
  - `003` adds `NOTIFY inventory_changed`.
- `Backend/initLocalDb.js` creates the same 7 tables in SQLite: `users`, `inventory_items`, `customers`, `order_profiles`, `order_items`, `payments`, `material_loss`.
- Money is `NUMERIC(10,2)` in Neon. CHECK constraints:
  - `role ∈ {Owner, Admin, Production, Staff}`
  - `production_status ∈ {Pending, Printing, Completed, Delayed, Cancelled}`
  - `payment_type ∈ {Cash, GCash, Bank Transfer}`
  - `sync_status ∈ {synced, pending_insert, pending_update}`
- On startup, `services/schemaCheck.js` prints one "CLOUD SCHEMA IS OUT OF DATE" message listing missing columns and triggers.

### Postgres `last_modified` trigger (migration 001/002)
- A `BEFORE UPDATE` trigger on every table sets `last_modified = NOW()` **only when a value actually changed**. A no-op update keeps the old version.
- This is what lets the optimistic concurrency check catch raw SQL and any future route. Never bypass it or set `last_modified` manually to an old value.

### Offline sync routing
- **Writes are cloud-first.** If the Neon call fails, `isConnectionError(err)` (`utils/dbErrors.js`) decides what happens:
  - A **connection** failure falls back to SQLite with `sync_status = 'pending_insert'` / `'pending_update'`.
  - **Any other error** (constraint, bad data) is returned as 4xx/5xx through `sendDbError` and **never** cached (audit C5).
- **`services/sync.js`:**
  - Pushes in parent-before-child order: `inventory_items`, `customers`, then `order_profiles`, then `order_items`, `payments`, `material_loss`.
  - Runs single-flight: a second call joins the running sync.
  - A row is marked synced only if its `last_modified` hasn't changed since it was read (H3).
  - Offline edits record `dirty_fields`, and only those fields are pushed (C3).
  - After pushing, it refreshes all 6 tables from Neon into SQLite without overwriting unsynced local rows.
  - Runs at startup, every 5 minutes, and on `POST /api/sync`, which returns 200, **409 `SYNC_CONFLICT`** or 503.
- **SQLite-only bookkeeping columns** (added at startup by `utils/localSync.js`): `dirty_fields`, `cloud_last_modified`, `sync_conflict`, `sync_error`, and `material_loss.cloud_stock_delta`.
- **Offline stock changes:** an offline stock change against a cloud item stores the delta (`cloud_stock_delta`). Sync replays it in Neon **in the same transaction** as the child insert, so it is applied exactly once. Copy this pattern for reservations (§4.5).
- **Local transactions** must use `withLocalTransaction(req.localDbPath, fn)` from `services/records.js`. It opens a dedicated SQLite connection with `BEGIN IMMEDIATE`. **Never** run BEGIN/COMMIT on the shared `req.localDb`.
- **Cloud transactions** use `withPgTransaction(req.pgPool, fn)`. It uses one client, and tags `err.commitUnknown` if the connection drops during COMMIT. In that case return 503 `COMMIT_UNKNOWN`. **Do not** fall back offline.

### Secured auth
- JWT is HS256 with 8h expiry and payload `{ user_id, role }`. `middleware/authMiddleware.js` provides `verifyToken` and `requireRole([...])`. The role is always taken from the token, never from the request body.
- `POST /api/auth/register` is **Admin-only** (audit C1). There is no public sign-up. The first account comes from `npm run create-admin`, which creates an **Admin**.
- Passwords are bcrypt with cost 10, 8–72 bytes.

### Optimistic concurrency and locks
- Every record has a **`version`**: Neon `last_modified` as `YYYY-MM-DDTHH:MM:SS.US`. Writes accept `expected_version` and run `UPDATE ... WHERE id = $1 AND to_char(last_modified, ...) = $expected`. Zero rows updated means **409 `EDIT_CONFLICT`** with the `current` record (see `PATCH /api/orders/:order_id/design`).
- **Order edit locks** live in `services/orderLocks.js`, in memory per process:
  - Rank is `Owner 4 > Admin 3 > Production 2 > Staff 1`, and a higher rank can take over a lower rank's lock. TTL is 2 minutes, and locks are released on disconnect.
  - Socket events: `editing_order` / `release_order`, plus `order_locked`, `order_unlocked`, `order_lock_revoked` and `locks_snapshot`.
  - REST write routes use `requireOrderEditAccess`, which returns **409 `ORDER_LOCKED`**.
- Socket.io connections need a valid JWT (`io(url, { auth: { token } })`).

### Validation and errors
- **`utils/validation.js`** (`createValidator()`):
  - Numbers must be JSON numbers; the text `"5"` is rejected.
  - Quantities are positive integers. Money is positive with at most 2 decimal places.
  - Deadlines are real dates, not in the past, in `Asia/Manila`.
  - IDs must match `^[A-Za-z0-9_.:@-]{1,50}$`.
  - Failures return `400 { error: 'VALIDATION_FAILED', message, details: [{ field, message }] }`.
- **Referenced records must exist:** check with `locateRecord(req, table, id)` (returns `'cloud' | 'local' | null`). A missing record returns `404 <ENTITY>_NOT_FOUND`.
- **Global JSON error handler:**
  - `req.body` defaults to `{}`.
  - 400 `INVALID_JSON`, 413, 404 `NOT_FOUND` for an unknown `/api` route.
  - 500 `INTERNAL_ERROR` with an `error_id`. No stack traces are sent.

---

## 2. Data shapes (finalized)
`services/records.js` turns rows from Neon **and** SQLite into the same JSON:
- money is a JSON number;
- timestamps are `YYYY-MM-DDTHH:MM:SS`;
- integers are numbers;
- every record gets `version`, `sync_status` and `sync_conflict`.

Use `selectList(table, 'pg'|'sqlite')` + `serialize(table, row)` for every new query and response. **Never return raw rows.**

### OrderProfile
```json
{
  "order_id": "uuid",
  "customer_id": "CUST-001",
  "date_created": "2026-10-06T09:15:00",
  "production_deadline": "2026-10-30T00:00:00",
  "production_status": "Pending",
  "design_drive_link": "https://drive.google.com/...",
  "total_quote_amount": 12500.00,
  "version": "2026-10-06T09:15:00.123456",
  "sync_status": "synced",
  "sync_conflict": false
}
```

### OrderItem
```json
{
  "line_item_id": "uuid",
  "order_id": "uuid",
  "inventory_id": "INV-1",
  "product_type": "Jersey",
  "quantity": 12,
  "size": "M",
  "custom_name": "DELA CRUZ",
  "custom_number": "7",
  "price": 450.00,
  "version": "…", "sync_status": "synced", "sync_conflict": false
}
```

### InventoryItem (as returned by `/api/inventory` and the socket push)
```json
{
  "inventory_id": "INV-1",
  "item_name": "Dri-fit Fabric (m)",
  "item_category": "Fabric",
  "quantity_available": 120,
  "quantity_reserved": 30,
  "minimum_threshold": 25,
  "unit_cost": 120.50,
  "version": "…", "sync_status": "synced", "sync_conflict": false,
  "quantity_available_net": 90,
  "stock_status": "in_stock"
}
```
- `quantity_available_net = max(0, quantity_available − quantity_reserved)`, from `computeAvailable` in `services/capacity.js`.
- `stock_status` is `out_of_stock` if net ≤ 0, `low_stock` if net ≤ `minimum_threshold`, otherwise `in_stock`.
- Both are calculated in `services/inventorySnapshot.js`.

### Read routes
| Route | Roles | Response |
|---|---|---|
| `GET /api/orders?status=&customer_id=&limit=&offset=` | Admin, Production, Staff | `{ source, orders[], limit, offset, unsynced }` |
| `GET /api/orders/:order_id` | Admin, Production, Staff | `{ source, order, items[], payments[], totals: { item_count, total_quantity, total_paid, balance } }` |
| `GET /api/orders/:order_id/items` | Admin, Production, Staff | `{ source, order_id, items[] }` |
| `GET /api/orders/:order_id/payments` | Admin, Production | `{ source, order_id, payments[], total_paid }` |
| `GET /api/inventory?category=&stock_status=&search=` | Admin, Production, Staff | `{ source, fetched_at, summary: { total_items, in_stock, low_stock, out_of_stock, unsynced, stock_value }, categories[], items[] }` |

- `source` is `'cloud'` or `'local'`.
- When online, lists also include local rows that are still `pending_insert`.
- Write responses are `{ message, source, <record> }`. `POST /api/orders` also returns `order_id` and `production_status` at the top level.

---

## 3. Frontend state
- **`src/InventoryCatalog.jsx`** receives the inventory snapshot from `App.jsx`. It shows:
  - summary cards, which also filter by status;
  - search and category filters;
  - per-item cards with **Available / Reserved / Min. Threshold**, a status badge, "Free to use", and ₱ unit cost;
  - an offline banner when `source === 'local'`, and a "Pending sync" tag on unsynced items;
  - a live indicator: green **Live**, "(this server only)" when cross-branch push is off, or grey and polling.
- **Real-time stock (Socket.io)** is opened once per login in `App.jsx`:
  - The client emits `inventory_subscribe`, and the server acknowledges with `{ ok, listening, snapshot }`.
  - The server pushes `inventory_updated { reason, changed_ids, snapshot }`. Changed cards are highlighted for 2.5s.
  - The server pushes `inventory_live { listening }`.
  - 30-second polling runs **only while the socket is disconnected**.
- **Server side** (`services/inventoryEvents.js`):
  - It `LISTEN`s on the Postgres channel `inventory_changed`, which migration 003 fires on every committed change to `inventory_items` from any branch, script or SQL editor.
  - It also accepts `req.inventoryEvents.notifyChanged(ids, reason)` from this process's own writes, including offline ones.
  - Bursts are combined into one push within 250ms. Rows that changed in the cloud are copied into the SQLite cache immediately.
  - **`LISTEN` doesn't work on Neon's pooled `-pooler` endpoint.** Set `PG_LISTEN_URL` to the **direct** connection string.
- The **Create Order** tab uses the same inventory snapshot for its material picker and handles the capacity alert (409) with Delay / Cancel.
- There is **no UI yet** for viewing an order or a list of orders. Sprint 11 adds the approval UI (§4.7).

---

## 4. Sprint 11 objectives: PB 13 "Approve Job Order & Reserve Blank Stock"

### 4.1 Prerequisites (do these first, in the same PR)
1. **Owner accounts.** Nothing can create an `Owner` today: `createAdmin.js` hard-codes `Admin`, and `routes/auth.js` has `ALLOWED_ROLES = ['Admin', 'Production', 'Staff']`.
   - Add `ADMIN_ROLE=Owner` support to `scripts/createAdmin.js`; it must accept only `Owner` or `Admin`.
   - Let `/register` create `Owner` **only when the caller is an Owner**.
2. **Order items must reference stock.** `POST /api/orders/:order_id/items` currently never saves `inventory_id`.
   - Accept an **optional** `inventory_id`. Validate it with `v.id(...)` and check it exists with `locateRecord(req, 'inventory_items', id)`.
   - Store it in both the online and offline paths.
   - Items without `inventory_id` are allowed, but they **block approval** (§4.4).
3. **Approval columns.** Write migration `004_job_order_approval.sql`, idempotent, and mirror it in `initLocalDb.js` and `ENTITIES.order_profiles` in `services/records.js`:
   - `ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_by VARCHAR(50) REFERENCES users(user_id);`
   - `ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;`
   - Add `'Approved'` to the `production_status` CHECK constraint (drop and re-add the constraint by name, guarded by `IF EXISTS`). The resulting lifecycle is `Pending → Approved → Printing → Completed`, plus `Delayed` / `Cancelled`.
   - Add a `CHECK (quantity_reserved >= 0 AND quantity_available >= 0)` constraint on `inventory_items`, as a defence in depth.

### 4.2 Endpoint
`POST /api/orders/:order_id/approve`

Body: `{ "expected_version": "<order.version>" }`. It is **required**: an approval must be based on the order the Owner actually looked at.

### 4.3 Authorization locks (strict)
- Middleware order: `verifyToken` → `requireRole(['Owner'])` → `requireOrderEditAccess`.
  - **Only `Owner`.** Admin, Production and Staff get **403**.
  - The role comes from the JWT only, never from the request body.
- If another user holds the order's edit lock, the existing lock check returns **409 `ORDER_LOCKED`**. An Owner can take over any lock, by design.
- On the frontend, show the **Approve** button only when `user.role === 'Owner'`. The server check is the real protection.

### 4.4 Preconditions (evaluated inside the transaction, after locking rows)
Check in this order. If any check fails, roll back and change nothing.
1. The order exists → otherwise **404 `ORDER_NOT_FOUND`**.
2. `to_char(last_modified, '<PG_VERSION_FORMAT>') = expected_version` → otherwise **409 `EDIT_CONFLICT`**, returning `current`.
3. `production_status` is `Pending` or `Delayed` → otherwise **409 `INVALID_STATUS_TRANSITION`**. Already `Approved` returns `ALREADY_APPROVED`; `Cancelled` or `Completed` are not allowed.
4. `total_quote_amount > 0` → otherwise **422 `QUOTE_REQUIRED`**.
5. **50% downpayment guard.** `SUM(payments.amount)` for the order must be at least `total_quote_amount × 0.50`.
   - Compare in **integer centavos** (`ROUND(x * 100)`), or with `NUMERIC` in SQL. **Never** compare JS floats.
   - Otherwise **402 `DOWNPAYMENT_REQUIRED`** with `{ total_quote_amount, required_downpayment, total_paid, remaining }`.
   - Count **only payments that exist in Neon**. Payments still pending offline do not count. Tell the user to sync first.
6. The order has at least one item, and **every** item has an `inventory_id` → otherwise **422 `ITEMS_NOT_LINKED_TO_STOCK`** with the offending `line_item_id`s.
7. **Capacity.** Add up the quantities per `inventory_id` across the order's items. For each item, `required ≤ quantity_available` must hold, otherwise **409 `INSUFFICIENT_INVENTORY`** with `shortages[]`, in the same shape as the Sprint 9 capacity check.

### 4.5 Atomic stock reservation
**Reservation semantics (business decision):** approving a job order *moves* blank stock from free to reserved:
`quantity_available -= required` and `quantity_reserved += required`.

> ⚠️ This conflicts with the current formula `quantity_available_net = quantity_available − quantity_reserved` used by `services/capacity.js` (Sprint 9 halt logic), `services/inventorySnapshot.js` and the UI. With the "move" model, reserved stock would be subtracted **twice**.
>
> **Required action:** change `computeAvailable` to return `quantity_available` (free stock). Update the capacity check, `stockStatusOf` and the UI ("Free to use" = Available). Keep `quantity_reserved` as a separate count of committed stock. Then update this steering file.
>
> If the team instead keeps "available = on-hand", reserve with `quantity_reserved += required` only. **Pick one model, document it here, and test it.** Do not mix them.

**Online (Neon). This must be one `withPgTransaction`:**
```sql
-- 1. lock the order
SELECT ... FROM order_profiles WHERE order_id = $1 FOR UPDATE;
-- 2. lock every stock row involved, in a FIXED ORDER, to prevent deadlocks
SELECT inventory_id, quantity_available, quantity_reserved
  FROM inventory_items WHERE inventory_id = ANY($2) ORDER BY inventory_id FOR UPDATE;
-- 3. run the §4.4 checks on the locked data
-- 4. reserve, guarded in SQL, never only in JS
UPDATE inventory_items
   SET quantity_available = quantity_available - $qty,
       quantity_reserved  = quantity_reserved  + $qty
 WHERE inventory_id = $id AND quantity_available >= $qty;   -- rowCount must be 1, else throw and roll back
-- 5. approve
UPDATE order_profiles SET production_status = 'Approved', approved_by = $user, approved_at = NOW()
 WHERE order_id = $1;
COMMIT;
```
- The `last_modified` trigger bumps the versions automatically. Do not set them yourself.
- If `err.commitUnknown` is set, return **503 `COMMIT_UNKNOWN`**. Do **not** retry offline.
- Approvals done online fire NOTIFY on commit, which pushes `inventory_updated` to every branch. Also call `req.inventoryEvents.notifyChanged(ids, 'order_approved')`.

**Offline (Neon unreachable): decide and implement ONE of these, and document which.**
- **(Recommended) Approve online only.** Return **503 `APPROVAL_REQUIRES_CLOUD`**. Approval is a financial commitment that depends on cloud payments and stock shared across branches, and doing it offline risks double-reserving the same blank stock at two branches.
- **Offline approval.** Use `withLocalTransaction` with the same checks, then record per-item reservation deltas (like `cloud_stock_delta`). Sync must apply all deltas **and** the status change in one Neon transaction. It must re-check stock and the downpayment there, and mark the order as `sync_conflict` if they no longer hold. Only choose this if it's explicitly requested.

### 4.6 Response
`200 { message: 'Job order approved.', source: 'cloud', order, reserved: [{ inventory_id, item_name, quantity }], inventory: [<InventoryItem>...] }`

`order` and `inventory` must use the serialized shapes from §2.

### 4.7 Frontend
- Add an **Orders** tab (inline styles) that lists `GET /api/orders` with status badges. Clicking an order shows `GET /api/orders/:order_id` (items, payments, totals).
- Owner-only **Approve Job Order** button, sending `expected_version: order.version`. Show the downpayment progress, e.g. "₱6,000 of ₱6,250 required (50%)", and disable the button with an explanation when a precondition is unmet.
- Error handling:
  - `402`: show the remaining downpayment.
  - `409 INSUFFICIENT_INVENTORY`: reuse the shortage table style from the capacity modal.
  - `409 EDIT_CONFLICT`: say "Order changed, reload".
  - `409 ORDER_LOCKED`: show who holds the lock.
  - `503`: say "Approval needs an internet connection".
- The Catalog updates by itself through `inventory_updated`. Do not add polling.

### 4.8 Acceptance tests (run against real Postgres, not mocks)
1. A non-Owner gets 403 and nothing changes. Missing or stale `expected_version` gets 400 / 409.
2. Paying 49.99% gives 402. Paying exactly 50.00% succeeds; check with a quote whose half isn't a whole centavo, e.g. ₱999.99.
3. Payments still pending offline don't count toward the downpayment.
4. An item without `inventory_id` gives 422. A shortage gives 409, and **nothing** changes, including on the other items.
5. A successful approval moves the right quantities per item (duplicate `inventory_id` lines are added up), and the status becomes `Approved`.
6. Force a failure after the first stock UPDATE (for example a temporary trigger that raises): everything rolls back.
7. **Concurrency:** two Owners approving two orders that compete for the same stock at the same time. Exactly one succeeds, the other gets 409, and stock never goes negative. The same order approved twice at the same time gives one 200 and one `ALREADY_APPROVED`.
8. Re-approving an approved order gives 409 `ALREADY_APPROVED`, with no second reservation.
9. Every connected client receives `inventory_updated` with the new available and reserved numbers.
10. With Neon down, the behaviour matches the offline option you chose in §4.5.

### 4.9 Out of scope for Sprint 11
- Releasing reservations when a job is cancelled or completed (consuming reserved stock). Note it as a follow-up; whoever builds it must use the same transaction pattern.
- Payment refunds and editing quotes after approval.

---

## 5. Operations checklist
- Before running: `cd Backend && npm run migrate`. If the server prints "CLOUD SCHEMA IS OUT OF DATE", the migrations haven't been applied.
- `.env` needs:
  - `DATABASE_URL` (the pooled URL is fine);
  - `PG_LISTEN_URL` (the **direct** Neon URL, used for real-time push);
  - `JWT_SECRET`;
  - optionally `BUSINESS_TIMEZONE` (default `Asia/Manila`) and `PORT` (default 5000).
- First account: `ADMIN_USERNAME=... ADMIN_PASSWORD=... npm run create-admin`. After §4.1, add `ADMIN_ROLE=Owner` for an Owner.
