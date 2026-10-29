# XiaoWuSys Sprint 12: Safe Deletion, Damaged Products & Audit Trail (PB 18–20)

> Master context for a new AI session. Read this whole file before changing any code.
> Repository: `EnriMiguelCostan/XiaoWuSys`. App root: `XiaoWuSys-main/` (`Backend/`, `Frontend/`, `docs/`).
> PB 18–20 are not defined anywhere else in the repo. This file is their definition.

## 0. Ground rules
- **Read before you write.** Before designing anything, open these files:
  - `Backend/routes/orders.js` (approve, status and details routes);
  - `Backend/routes/inventory.js` (`/loss`, `/adjust`, Recycle Bin routes);
  - `Backend/routes/auth.js` (the `PATCH /users/:id` transaction is the newest pattern);
  - `Backend/services/records.js`, `services/sync.js`, `services/localSchema.js`, `services/inventoryAudit.js`, `services/recycleBin.js`;
  - `Backend/utils/localSync.js`, `utils/validation.js`, `utils/dbErrors.js`;
  - `Backend/app.js`;
  - `Backend/migrations/004`–`006`.
- **Styling:** React inline styles only, matching `OrdersPage.jsx` and `InventoryCatalog.jsx`. **No Tailwind, CSS frameworks or component libraries.** `lucide-react` icons are already allowed.
- **Schema:** the next migration is **`007_...sql`**.
  - It must be idempotent: `IF NOT EXISTS`, and constraints dropped by name with `IF EXISTS` before being re-added.
  - It must not fail on legacy data: add CHECKs `NOT VALID`, then validate only when existing rows pass.
  - Mirror every change in `services/localSchema.js` and in `TABLE_EXTRA_COLUMNS` (`utils/localSync.js`).
  - Mirror it in `ENTITIES` (`services/records.js`), in `SYNC_TABLES` (`services/sync.js`) and in `services/schemaCheck.js`.
  - Never edit an applied migration. Migrations run automatically at start-up (`AUTO_MIGRATE=false` turns this off).
- **Git:** work on a new branch off `main`, never commit to `main`, and open a PR through the GitHub REST API. `main` requires **1 approving review**, so you cannot merge your own PR.
- **Tests:** keep `npm test` (Node runner, 55 tests, SQLite plus in-memory test doubles) passing. Add a test file per PB. Also run the concurrency and rollback cases against **real PostgreSQL**, because test doubles cannot prove row locks. When you change SQL that `tests/accounts-online.test.js` matches, update its test double too.
- `npm ci` must work from a clean checkout. If you change dependencies, regenerate `package-lock.json` with `npm install` and commit it.

## 1. Architecture you must keep
### Stack
- **Backend:** Node 22, Express 5, `pg`, `sqlite3`, Socket.io 4, JWT (HS256), bcrypt.
- **App factory:** `createApp()` in `Backend/app.js` is shared by `server.js` and the tests.
- **Databases:** Neon PostgreSQL is the source of truth. SQLite (`local_cache.db`) is the offline cache.
- **Frontend:** React 19 + Vite. The API address comes from `VITE_API_URL` (`src/config.js`).
- **Offline-only mode:** `CLOUD_DISABLED=true`, or no `DATABASE_URL`, swaps in `services/cloudDisabledPool.js`. `npm run demo` uses it.

### Write rules (non-negotiable)
1. **Validation first:** use `createValidator()`. Numbers must be JSON numbers, IDs must match `^[A-Za-z0-9_.:@-]{1,50}$`, and failures return `400 VALIDATION_FAILED`.
2. **Errors:** route catch blocks send business rejections as `{ error, message }` through a `Rejected` class. Everything else goes to `sendDbError` or the global JSON handler in `app.js`. Never send raw errors or stack traces.
3. **Transactions:**
   - Use `withPgTransaction(req.pgPool, fn)` on one client.
   - Lock rows with `SELECT ... FOR UPDATE`, ordered by primary key, to avoid deadlocks.
   - Check every precondition on the **locked** rows.
   - Guard every write in SQL (`WHERE ... AND <guard>`) and assert `rowCount`. Never guard only in JavaScript.
   - `err.commitUnknown` means `503 COMMIT_UNKNOWN`. Never fall back offline in that case.
   - The reference implementations are `POST /orders/:id/approve` and `PATCH /auth/users/:id`.
4. **Offline (C5):**
   - Only `isConnectionError(err)` may fall back to SQLite, using `withLocalTransaction(req.localDbPath, fn)`. Never run BEGIN on `req.localDb`.
   - Offline rows get `sync_status = pending_insert` or `pending_update`, and `offlineUpdateBookkeeping()` records `dirty_fields`.
   - Offline stock deltas against cloud rows use the `cloud_stock_delta` pattern from `material_loss`.
5. **Optimistic concurrency:** every record has a `version` (Neon `last_modified`). Writes take `expected_version`, and a mismatch returns **409 `EDIT_CONFLICT`** with `current`. The `last_modified` trigger (migration 001) must never be bypassed.
6. **Edit locks:** order write routes use `requireOrderEditAccess`, which returns **409 `ORDER_LOCKED`**. The Owner prevails over lower ranks.
7. **Shapes:** use `selectList()` + `serialize()` for every query. Money is a JSON number, rounded to 2 decimals. Compare money in **integer centavos**, never as JS floats.
8. **Real-time stock:** after any change to `inventory_items`, call `req.inventoryEvents.notifyChanged(ids, reason)`. Never change the `inventory_updated { reason, changed_ids, snapshot }` shape.
9. **Auth:** roles come from the JWT only. `requireRole([...])` returns 403 `FORBIDDEN`.
   - Ranks: `Owner > Admin > Production > Staff`.
   - Account changes set `users.tokens_valid_after`, so old sessions end (`services/sessions.js`).

### Stock model (do not change)
- `quantity_available` is the physical stock on hand. `quantity_reserved` is stock promised to orders. Free stock is `available − reserved` (`computeAvailable`).
- Order lifecycle: `Pending → Approved (Owner, 50% downpayment) → Printing → Completed`, plus `Delayed` / `Cancelled`.
  - Creating a Pending order reserves its stock (`stock_reserved = true`).
  - Cancel releases the reservation. Complete consumes it (`available −= qty`, `reserved −= qty`).
  - Approval reserves only if the order is not already reserved.
- **A CHECK keeps `quantity_reserved` and `quantity_available` ≥ 0** (migration 005).

### Existing deletion and logging (reuse it, don't duplicate it)
- **Inventory Recycle Bin (migration 004):** uses `deleted_at` / `deleted_by` for soft delete and `purged_at` for "permanently deleted but still referenced".
  - `ACTIVE_ITEM_SQL` and `BIN_ITEM_SQL` are in `records.js`.
  - The janitor purges bin items after `RECYCLE_BIN_RETENTION_DAYS` (30). **This applies to inventory items only and stays as it is.**
- **`inventory_audit_log`:** append-only, enforced by a trigger that blocks UPDATE and DELETE. It is written in the **same transaction** as each catalog change, through `auditCloud` / `auditLocal`.
- **`POST /inventory/:id/loss`:** subtracts lost stock immediately and records a `material_loss` row with its `financial_cost`. It has no verification step today.

## 2. Business decisions (final)
- **D1. Misprint stock source:** a misprint or damaged product uses up **general stock**, not the order's reserved stock. So on verification, `quantity_available −= qty` and **`quantity_reserved` is left alone**. The order keeps its full reservation, and Complete still consumes it. Verification is refused unless free stock (`available − reserved`) is at least `qty`, so it can never eat into stock reserved for any order.
- **D2. Archive retention:** archived records (orders, customers, payments, losses) are **kept forever** for the audit trail.
  - There is no purge, no janitor and no hard-delete endpoint for them.
  - "Delete" in the UI always means archive.
  - The 30-day purge stays limited to the inventory Recycle Bin.
- **D3.** Payments are never archived or edited. A mistaken payment is **voided** by writing a reversing entry, which keeps totals traceable.
- **D4.** The person who reports damage cannot be the person who verifies it.

## 3. PB 18: Safe deletion (archive, never destroy)
### Schema (migration 007)
- Add `archived_at TIMESTAMP`, `archived_by VARCHAR(50) REFERENCES users(user_id)` and `archive_reason TEXT` to `order_profiles` and `customers`.
- Add partial indexes `WHERE archived_at IS NULL`.
- `payments`: add `voids_payment_id VARCHAR(50) REFERENCES payments(payment_id)` and `void_reason TEXT`. Add a unique partial index on `voids_payment_id` so a payment can be voided only once.
- Add `ACTIVE_ORDER_SQL` and `ACTIVE_CUSTOMER_SQL` to `records.js`, like `ACTIVE_ITEM_SQL`.

### API
| Route | Roles | Rules |
|---|---|---|
| `POST /api/orders/:id/archive` `{ reason, expected_version }` | Owner, Admin | Cloud only. Uses `requireOrderEditAccess`. Only `Completed` or `Cancelled` orders can be archived, otherwise `409 ORDER_STILL_OPEN` (cancel first, so stock is released through the existing guarded path). `reason` is required, 3–255 characters. |
| `POST /api/orders/:id/unarchive` `{ expected_version }` | Owner, Admin | Cloud only. |
| `POST /api/customers/:id/archive` and `/unarchive` | Owner, Admin | `409 CUSTOMER_HAS_OPEN_ORDERS` if any order that is not archived, Completed or Cancelled exists. Lock the customer row first, then its orders `FOR UPDATE`. |
| `POST /api/orders/:id/payments/:payment_id/void` `{ reason }` | Owner, Admin | Inserts a payment of `-amount` with `voids_payment_id`. If the order is Approved, refuse the void when it would push paid below 50% of the quote, with `409 VOID_BREAKS_DOWNPAYMENT`. Compare in centavos. |

- List routes hide archived rows by default and accept `?include_archived=true` (Owner, Admin only).
- Detail routes still return archived records, with `archived_at` set.
- Writes to archived records return `409 RECORD_ARCHIVED`. That covers payments, items, status, details and design.
- Payment validation still rejects negative amounts from clients; only the void route creates them.
- `/orders/:id` `totals.total_paid` includes voids.
- Every archive, unarchive and void writes an audit row (PB 20) in the same transaction.

### Frontend
- **Orders table:**
  - add a "Show archived" toggle (Owner/Admin) and an "Archived" badge;
  - in the pop-up footer, add an "Archive" button for closed orders;
  - add a reason dialog using `ConfirmDialog` plus a text field.
- **Payments table:** add a "Void" action, and show voided rows struck through with the reason.

## 4. PB 19: Damaged / misprint logging with verification
### Schema (migration 007)
Extend `material_loss`:
- `loss_type VARCHAR(20) NOT NULL DEFAULT 'lost'`, with `CHECK (loss_type IN ('lost', 'damaged', 'misprint'))`;
- `status VARCHAR(20) NOT NULL DEFAULT 'Verified'`, with `CHECK (status IN ('Pending', 'Verified', 'Rejected'))`. Existing rows stay `Verified`;
- `reported_by`, `verified_by` (both FK to `users`), `verified_at`, `rejection_reason`, and `evidence_link` (validated like `design_drive_link`).

### Flow
1. **Report:** `POST /api/inventory/:id/damage` with body `{ loss_type: 'damaged'|'misprint', quantity, reason, order_id?, evidence_link? }`.
   - **Roles:** Owner, Admin, Production.
   - **Effect:** inserts a `Pending` row and **does not change stock**.
   - **Offline:** works offline (`pending_insert`), because the stock is untouched.
   - `order_id` is required for `misprint`. The order must exist and be Approved or Printing.
2. **Verify:** `POST /api/inventory/losses/:loss_id/verify` with body `{ expected_version }`.
   - **Roles:** Owner, Admin. **Cloud only.**
   - Runs in one `withPgTransaction`. Lock the loss row `FOR UPDATE`, then the inventory row, in that order.
   - **Checks:**
     - status is `Pending` (otherwise `409 LOSS_ALREADY_DECIDED`);
     - `verified_by <> reported_by` (otherwise `403 SELF_VERIFICATION`);
     - the item is active.
   - Then run, guarded in SQL:
     `UPDATE inventory_items SET quantity_available = quantity_available - $q WHERE inventory_id = $i AND quantity_available - quantity_reserved >= $q`, with `rowCount === 1`. Otherwise return `409 INSUFFICIENT_FREE_STOCK` (D1).
   - Set `status = 'Verified'`, `verified_by`, `verified_at` and `financial_cost = qty × unit_cost`, computed in SQL as `NUMERIC`.
   - Write an audit row, then call `notifyChanged`.
3. **Reject:** `POST /api/inventory/losses/:loss_id/reject` with body `{ reason, expected_version }`. Roles: Owner, Admin. Cloud only. Same locks. Stock is not touched.
4. **List:** `GET /api/inventory/losses?status=&type=&inventory_id=&order_id=` (all roles). Uses `serialize`.
5. The existing `POST /:id/loss` stays for immediate "lost" stock counts (`loss_type = 'lost'`, `Verified`), so nothing breaks.

### Frontend
- **Catalog:** Manage Stock gets a "Report damage / misprint" form.
- **New "Waste" tab** (inline styles):
  - a Pending queue with Verify/Reject for Owner/Admin. The button is hidden for the reporter, with the reason shown;
  - a history table with sort and filter, as in the inventory table;
  - totals of `financial_cost` per month and per type.
- **Order pop-up:** add a "Report misprint" action for Approved/Printing orders.

## 5. PB 20: Audit trail and reports
- **Schema (migration 007):** add a general append-only `audit_log`.
  - Columns: `audit_id`, `entity` (`order|customer|payment|material_loss|user`), `entity_id`, `action`, `details` JSONB (before/after), `performed_by`, `performed_role`, `created_at`.
  - Block UPDATE and DELETE with a trigger, as `forbid_audit_change()` does for `inventory_audit_log`.
  - **No retention or purge** (D2).
  - Keep `inventory_audit_log` as it is. Do not merge the two tables.
- **Writes:** use `services/audit.js` with `auditCloud(client, ...)` / `auditLocal(tx, ...)`, always in the **same transaction** as the change.
  - Order actions: approve, status change, details edit, archive and unarchive.
  - Payment actions: insert and void.
  - Loss actions: report, verify and reject.
  - Account actions: create, role change, deactivate/reactivate and password reset. Never log password hashes.
  - Sync it like `inventory_audit_log`: push it (insert-only), never refresh it back into the cache.
- **Read:** `GET /api/audit?entity=&entity_id=&from=&to=&limit=&offset=` for Owner and Admin, read-only and paginated. Add an "Activity" section in the order pop-up for Owner/Admin.
- **Reports:** add `GET /api/reports/export/waste.csv` and `audit.csv`, reusing `csvCell` (formula-safe). The dashboard gets "Waste this month" (₱, integer centavos).

## 6. Acceptance tests (real PostgreSQL for anything with locks)
1. **Archiving:**
   - archiving an open order returns 409;
   - an archived order is hidden from lists and visible with `include_archived`;
   - every write to it returns `RECORD_ARCHIVED`;
   - unarchive restores it;
   - **no route deletes order, customer, payment or loss rows**, so grep for `DELETE FROM` in those routes.
2. **Voids:**
   - voiding twice: one 200 and one 409, enforced by the unique index;
   - a void that drops an Approved order below 50% returns 409;
   - totals include voids.
3. **Damage reports:** a report does not change stock. Reporter = verifier returns 403.
4. **D1 (misprint stock source):**
   - setup: available 10, reserved 8, misprint 3, so free stock is 2;
   - verifying returns `409 INSUFFICIENT_FREE_STOCK` and nothing changes;
   - with free stock ≥ 3, verifying sets `available −3` and leaves `reserved` **unchanged**;
   - completing the order afterwards still consumes its full reservation.
5. **Concurrency:** two verifies of the same loss at once give one 200 and one `LOSS_ALREADY_DECIDED`, and stock drops once. Two verifies of different losses competing for the same free stock: stock never goes negative or below reserved.
6. **Rollback:** force a failure after the stock UPDATE (a temporary trigger) and everything rolls back, including the audit row.
7. **Audit:** every action in §5 writes exactly one audit row. `UPDATE` and `DELETE` on `audit_log` both raise. Hashes never appear in `details`.
8. **Offline:** a report works offline and syncs. Verify, reject, archive and void all return 503 offline and change nothing locally.
9. **Socket:** a verified loss pushes `inventory_updated` with the new numbers.
10. **Clean install:** `npm ci` and `npm test` pass from a clean checkout. ESLint and `vite build` pass for the frontend.

## 7. Out of scope
- Hard deletion of anything except inventory items through the existing Recycle Bin.
- Editing or deleting audit rows, including by admins.
- Refunds that move money. A void is bookkeeping only.
- Photo upload for evidence. Use a Google Drive link (`evidence_link`), validated like the design link.
