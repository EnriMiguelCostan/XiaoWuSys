# XiaoWuSys Sprint 12 steering: Gap Remediation, then Deduct Consumables (PB 15) & Notify Low Stock (PB 17)

> Master context for a new AI session. Read this whole file before changing any code.
> Repository: `EnriMiguelCostan/XiaoWuSys`. App root: `XiaoWuSys-main/` (`Backend/`, `Frontend/`, `docs/`).
> State described: `main` at `01f8fab` (after PR #14). Check with `git log --oneline -5`.
>
> **This file replaces an earlier draft** that called "Safe Deletion, Damaged Products & Audit Trail"
> PB 18–20. Those numbers were wrong. The PB numbers here match the team's Product Backlog,
> Sprint Backlog and UAC sheet (§1). The earlier draft's content has been moved to the correct
> backlog items in §7.

---

## 0. Ground rules (non-negotiable)

1. **Read before you write.** Before designing anything, open:
   - the files you will touch;
   - `services/records.js`, `services/sync.js`, `services/localSchema.js`, `services/schemaCheck.js`;
   - `utils/validation.js`, `utils/dbErrors.js`, `utils/localSync.js`;
   - the relevant `routes/*.js`.

   Reuse the existing helpers. Never re-implement them.
2. **Keep business logic out of the UI** (§3 explains why). Every rule lives on the server, and the API returns derived values. Screens only display what the API returns.
3. **Styling stays as React inline styles** until the migration (§3):
   - one style object at the bottom of each component file;
   - no Tailwind, CSS frameworks or UI component libraries;
   - `lucide-react` icons only;
   - form controls set `color: '#0f172a'`, `backgroundColor: '#fff'` and `colorScheme: 'light'`.
4. **Errors are structured JSON:** `{ error: 'MACHINE_CODE', message: 'Plain sentence', ...details }`.
   - Database errors go through `sendDbError`.
   - Business-rule failures inside a transaction are thrown as `throw new Rejected(status, {...})`.
   - Anything else falls to the global handler in `app.js`.
5. **Schema changes are numbered, idempotent migrations** in `Backend/migrations/`.
   - **Batches 1–3 (§2) use `007`, `008` and `009`.** Sprint 12 feature work (PB 15) uses the next free number after those.
   - Never edit an applied migration.
   - Mirror every change in all of these places:
     - `services/localSchema.js` (new local databases);
     - `TABLE_EXTRA_COLUMNS` in `utils/localSync.js` (existing local databases);
     - `ENTITIES` in `services/records.js`;
     - `SYNC_TABLES` and `REFRESH_TABLES` in `services/sync.js`;
     - `EXTRA_COLUMNS` in `services/schemaCheck.js`.
   - For SQLite CHECK changes, copy the rebuild pattern from `upgradeLocalOrderStatusCheck`.
   - Re-attach the `last_modified` trigger on every new table.
   - Add CHECKs `NOT VALID` first so legacy rows never block the migration.
6. **Never weaken these guarantees:**
   - strict `createValidator()` validation;
   - role from the JWT only (`requireRole`);
   - `expected_version` optimistic concurrency and the `last_modified` trigger;
   - stock never negative (SQL guards and CHECKs);
   - offline fallback only on connection errors (audit C5);
   - parameterised SQL;
   - audit rows written in the same transaction as the change;
   - soft delete through the Recycle Bin;
   - money compared in integer centavos.
7. **Tests:**
   - Every new route gets tests in `Backend/tests/` using `startTestServer()`.
   - `npm test` stays green. It had 55 tests at the start of this sprint and 78 after Batch 1, plus 8 PostgreSQL migration tests (`tests/migrations.pg.test.js`) that run when `TEST_DATABASE_URL` is set, as in CI.
   - Cloud-only paths with row locks use the scripted-`pgPool` pattern from `accounts-online.test.js`.
   - Never point tests at the real Neon database.
   - The agent sandbox has no PostgreSQL and cannot download npm packages. CI (`.github/workflows/ci.yml`) runs the tests with the real packages and a PostgreSQL 16 service; a PR is only verified once CI is green.
8. **Git:**
   - Use a new branch off `main` per batch or PB. Never commit to `main`.
   - Open PRs through `gh api repos/.../pulls`. `main` needs 1 approving review.
   - Never commit `node_modules/`, `.env` or `*.db`.
9. **Wording on screen:** plain English for non-technical printshop staff.
   - No field names.
   - No raw IDs: show the tracking number once Batch 1 lands; until then `#` plus the first 8 characters.
   - No time-zone codes.

---

## 1. Backlog map (source of truth: Product Backlog, Sprint Backlog, UAC sheet)

Code status was checked against the UAC on 2026-10-29.

| PB | Sprint | Feature | Code status | Remaining work |
|---|---|---|---|---|
| 24 | 1 | UI/UX prototyping | Not in repo | Team's own files |
| 25 | 1 | Environment & server setup | Partly | CI pipeline done in Batch 1; hosting config remains |
| 1 | 1 | Login / logout | Done (Batch 1) | — |
| 2 | 2 | Role-based authorization | Done (Batch 1) | — |
| 3 | 3 | Local data cache (offline) | Mostly | **Batch 2:** connection watcher |
| 4 | 4 | Asynchronous cloud sync | Mostly | **Batch 2:** sync on reconnect, "Sync now" |
| 5 | 5 | Owner overrides staff edits | Partly | **Batch 3:** Owner wins, staff notified, offline conflicts resolved by rank |
| 6 | 6 | Create order profile | Done (Batch 1) | — |
| 7 | 7 | Encode order details | Done | — |
| 8 | 8 | Link design file | Done | — |
| 9 | 9 | Inventory capacity pre-check | Done (Batch 1) | — |
| 10 | 9 | Capacity alert & delay options | Done | Optional wording: "Pursue Later" |
| 11 | 10 | Generate official quote | Not started | Needs price tiers from client |
| 12 | 10 | Apply discount / final price | Not started | Needs Owner-only rules (Batch 1) and `audit_log` (Batch 3) |
| 13 | 11 | Approve job order | Done | Mark Completed in the sheet |
| 14 | 11 | Update production status | Partly | **Batch 3:** "Pressing", status timestamps, live push |
| 16 | 11 | Flag expiring deadline | Not started | Sprint 11 carry-over |
| 15 | **12** | Deduct consumables | Not started | **§5 of this file** |
| 17 | **12** | Notify low stock | Done (Batch 1) | Consumables join the warning with PB 15 |
| 18 | 13 | Record material loss | Partly | Misprint form with reason codes (§7) |
| 19 | 13 | Differentiate defect type | Not started | Scope to agree with adviser |
| 20 | 13 | Log financial waste cost | Mostly | Show waste cost in reports |
| 21 | 14 | Process payment | Mostly | **Batch 2:** cap, labels, receiver, receipt |
| 22 | 14 | Generate P&L report | Not started | Needs overhead entry; client's top priority |
| 23 | 14 | Void transaction | Partly | Reason, voided payments, audit (§7) |
| 26 | 15 | QA & load testing | Partly | 100+ concurrent-request test |
| 27 | 16 | UAT | Not started | Beta on branch devices, owner sign-off |

**Work order:** gap remediation Batches 1 → 2 → 3 (§2) first, then the Sprint 12 features (§5, §6).
Each batch is its own branch and PR, and needs the team's go-ahead before coding starts.

---

## 2. Gap remediation (do this before new features)

### Batch 1: Permissions, identity and quick wins (migration `007`) — BUILT

Batch 1 has no dependency on the other batches. It also lays down the shared domain layer that later batches build on.

**Decisions taken (2026-10-29):** Owner-only means the Admin is blocked too; order numbers are `XM-YYYY-NNNN`, restarting each year; Logout ends the current device only; CI is included.

**As built (differences from the table below):**
- `services/domain/` holds `permissions.js` (capability table), `orderLifecycle.js` (`STATUS_TRANSITIONS`, `allowedActions`) and `stockCheck.js`. Login and `GET /api/auth/me` return `capabilities`; `GET /api/orders/:id` returns `allowed_actions` and `stock_check`; `GET /api/orders` returns `capabilities`.
- Order numbers come from a per-year counter table (`order_tracking_counters`) and a BEFORE INSERT trigger, not a SEQUENCE, so a rolled-back order leaves no gap. The year is the creation date in Asia/Manila. The trigger overwrites any number a client sends and keeps a number once set. The sync never pushes `tracking_no` (`cloudOwned` in `SYNC_TABLES`) and copies the cloud's number into the local row right after the push.
- A non-Owner may still send `total_quote_amount: 0` ("no price yet") when creating an order.
- Logout writes `revoked_sessions` (cloud, plus a local copy; `pending_insert` when offline). Tokens issued before Batch 1 have no `sid` and simply expire.

| # | PB | Change | Server | Screens |
|---|---|---|---|---|
| 1.0 | — | **Domain layer** | Create `Backend/services/domain/`, holding pure functions with no Express and no SQL:<br>• `orderLifecycle.js` holds `STATUS_TRANSITIONS`, moved out of the route, and `allowedActions(order, role)`.<br>• `permissions.js` holds the role → capability map.<br>• Order responses gain `allowed_actions` and `capabilities`. | `OrdersPage.jsx` renders buttons from `allowed_actions`, and the duplicated `ACTIONS` table is reduced to labels and icons only. New non-UI frontend code goes in `src/lib/`, which has no React imports. |
| 1.1 | 1 | **Server-side logout** | New login tokens carry a session id (`sid`). `POST /api/auth/logout` records the `sid` in a new `revoked_sessions` table (`sid`, `user_id`, `expires_at`) in Neon and in SQLite. This works offline, and the table is push-only in sync. `services/sessions.js` rejects revoked `sid`s on REST and on sockets, and the user's sockets are disconnected. Only *this* device is signed out. | The Logout button calls the route, then clears local storage. |
| 1.2 | 2 | **Owner-only quote and void** | Setting or changing `total_quote_amount` (on `POST /api/orders` and `PATCH /:id/details`) requires Owner, otherwise 403 `QUOTE_OWNER_ONLY`. Cancelling an order after creation requires Owner, otherwise 403 `VOID_OWNER_ONLY`. The capacity-halt "Cancel Order" choice made while the order is being created stays open to the roles that create orders, because nothing is reserved or paid at that point. | The quote field and the Cancel button are hidden for non-Owners, and the reason is explained. |
| 1.3 | 6 | **Sequential tracking number** | Add `order_profiles.tracking_no` (UNIQUE), filled by the database on cloud insert (per-year counter, see "As built"). `order_id` stays a UUID, because sync and foreign keys depend on it. Offline orders get their number when they sync and show "Number given after sync" until then. The migration backfills existing orders by `created_at`. The number is searchable in `GET /api/orders`. | Shown everywhere instead of `#` plus 8 characters, including the Messenger copy text and the printed job order. |
| 1.4 | 9 | **Approve greyed out on stock shortage** | `GET /api/orders/:id` returns `stock_check: { sufficient, shortfalls: [{ inventory_id, item_name, needed, free }] }`, built from `services/capacity.js`. The approve route still re-checks inside its transaction. | The Approve button is disabled and lists what is short. |
| 1.5 | 17 | **Pinned yellow low-stock warning** | No server change. The dashboard already returns `inventory.restock`. | A yellow banner pinned at the top of the Dashboard lists low and out-of-stock items. It updates live from `inventory_updated` and disappears once stock is restocked. |
| 1.6 | 25 | **CI (optional, needs confirmation)** | Add `.github/workflows/ci.yml`: backend `npm ci && npm test`, frontend `npm ci && npm run lint && npm run build`. | — |

### Batch 2: Connection awareness and payments (migration `008`)

Payments and the connection status both touch the offline/sync path, so they are tested together.

| # | PB | Change | Server | Screens |
|---|---|---|---|---|
| 2.1 | 3 | **Connection watcher** | The server tracks cloud health. Any successful Neon query marks it reachable, and a connection error marks it unreachable. While unreachable *only*, it probes `SELECT 1` every 15s; it never probes while online, so Neon can still auto-suspend. `GET /api/status` adds `cloud: 'reachable' \| 'unreachable'`, with no secrets. New `GET /api/sync/status` (logged in) returns `{ cloud, last_sync_at, pending: {table: n}, conflicts }`. | `src/lib/connection.js` combines browser `online`/`offline` events, the socket state and `/api/sync/status`. It reports one of three states: **Online**, **Offline: saving on this computer**, or **Can't reach the shop server**. An always-visible status bar shows the current state. |
| 2.2 | 4 | **Sync on reconnect + "Sync now"** | When cloud health flips from unreachable to reachable, the server runs `syncAndNotify()` once. Single-flight already prevents overlap. | A "Sync now" button calls `POST /api/sync` and shows the result: done, conflicts, or cloud unreachable. A badge shows the number of changes waiting. |
| 2.3 | 21 | **Payment rules** | Cloud path:<br>• `withPgTransaction`, locking the order `FOR UPDATE`;<br>• requires a quote > 0;<br>• amount ≤ quote − paid in centavos, otherwise 409 `PAYMENT_EXCEEDS_BALANCE`;<br>• SQL guard and `rowCount` check.<br><br>Every payment also gets:<br>• **`received_by`** = the JWT user;<br>• **`receipt_no`** from a Neon sequence, assigned on sync for offline payments.<br><br>Derived **`payment_status`**: `Unpaid`, `Partial`, `Fully Paid` or `Overpaid`, computed in `services/domain/payments.js`.<br><br>Response warning (non-blocking): "Not enough downpayment to start production" when paid is below 50%.<br><br>**Offline:** capped against the local view. Sync never drops a payment. If branches together overpay, the order shows `Overpaid` for the Owner to review. | A Fully Paid / Partial / Unpaid / Overpaid label, a receiver column, and a printable **payment acknowledgement receipt**. This is not a BIR Official Receipt; SIA 1 says the system does not issue ORs. |

### Batch 3: Live production floor and Owner override (migration `009`)

This is the highest-risk batch. It depends on Batch 1 (domain layer and permissions) and Batch 2 (connection state).

| # | PB | Change | Server | Screens |
|---|---|---|---|---|
| 3.1 | 14 | **"Pressing" step** | New transitions: `Printing → Pressing → Completed`, with `Printing → Completed` kept for items with no pressing (pending confirmation), and `Pressing → Cancelled`. The status CHECK is swapped with the `NOT VALID` pattern, and SQLite is rebuilt. | A "Start Pressing" action, driven by `allowed_actions`. |
| 3.2 | 14 | **Status timestamps** | Append-only `order_status_history` (`order_id`, `from_status`, `to_status`, `changed_by`, `changed_role`, `changed_at`). It is written in the same transaction as every status change and approval, and UPDATE/DELETE are blocked by a trigger. It is included in `REFRESH_TABLES` so it can be read offline. | A timeline in the order pop-up. |
| 3.3 | 14 | **Live status across branches** | A trigger on `order_profiles` runs `pg_notify('orders_changed', {order_id, op})`. The `LISTEN` client in `inventoryEvents.js` is generalised into one shared cloud-events listener that handles both channels. It emits `order_updated { order_id, tracking_no, production_status, version }` to an `orders` socket room. | The Orders list, the open order and the Dashboard refresh on `order_updated`, with no new polling. |
| 3.4 | 5 | **Edit locks used by the screens** | Unchanged. The server-side locks already exist. | Opening edit mode emits `editing_order` (with an ack), renews every 60s, and sends `release_order` on close. Others see an "Edited by …" badge. `order_lock_revoked` shows: "The Owner took over this order. Your unsaved changes were not saved." |
| 3.5 | 5 | **Owner's edit wins online** | Add `last_edited_by` and `last_edited_role` to `order_profiles`. On `EDIT_CONFLICT`, if the caller outranks the last editor, the 409 includes `can_override: true`. The Owner confirms and re-sends with `override: true`. The server re-checks rank from the JWT, applies the change, writes an `audit_log` row (new append-only table), and emits `order_overridden` to the overridden user. | "Replace their changes with mine?" confirm for the Owner. A notice to staff: "The Owner replaced your changes to order XM-…". |
| 3.6 | 5 | **Offline conflicts resolved by rank** | During sync, when a pushed row conflicts:<br>• If the offline editor outranks the cloud's last editor, the offline edit is applied.<br>• Otherwise the cloud wins, and the discarded edit is kept in `audit_log` with the user notified.<br>• Equal ranks stay flagged.<br><br>New `POST /api/sync/conflicts/:table/:id/resolve { keep: 'cloud' \| 'local' }` for Owner/Admin. | A conflicts list with Keep-cloud / Keep-mine buttons. |

### Per-batch acceptance tests (minimum)

- **Happy path, validation (400 with plain message), permissions (403 for each disallowed role, nothing changed), stale `expected_version` (409).**
- **Batch 1:**
  - a revoked `sid` gets 401 on REST and is refused by sockets, and other devices stay signed in;
  - non-Owner quote and cancel give 403;
  - tracking numbers are strictly increasing and unique, offline orders get a number on sync, and the backfill is idempotent;
  - `stock_check` reports exact shortfalls.
- **Batch 2:**
  - the cloud health flip triggers exactly one sync;
  - no probing while online;
  - payment over the balance gives 409 and nothing is written;
  - two simultaneous payments can't exceed the balance (scripted `pgPool`, plus a real Postgres run by the team);
  - offline payments are never dropped, and an overpay shows `Overpaid`;
  - `received_by` comes from the JWT, not the body.
- **Batch 3:**
  - each status change writes exactly one history row, and history UPDATE/DELETE raise errors;
  - `order_updated` is emitted after COMMIT only;
  - an Owner override needs a higher rank and Staff can never override;
  - offline conflict resolution follows the rank rule;
  - the "Pressing" CHECK migration runs twice without error, and old SQLite caches are rebuilt with no rows lost.

---

## 3. End-of-project migration: Next.js, Tailwind CSS and a mobile app (team decision, final)

The current **Vite + React + inline styles** frontend is the **MVP/Beta**. It exists to stabilise the ERP logic. Final deployment follows the original SoftEng proposal:

- **Web:** Next.js with Tailwind CSS.
- **Mobile:** a mobile app. The framework is to be decided. React Native / Expo is the natural fit, because it can reuse the plain-JS modules in `src/lib/`.
- **Backend:** stays **Express + Node.js + Neon PostgreSQL + Socket.io + SQLite offline cache**, with the same REST and socket contract. The migration replaces the client apps only. Business rules are **not** rewritten.

### Rules that keep the migration cheap (apply them to all work from now on)

1. **The server owns every business rule.** Routes stay thin (validate → call a service → serialize). Rules live in `Backend/services/` (`services/domain/` from Batch 1), as pure functions that can be tested without HTTP.
2. **The API returns decisions, not raw data the client must interpret.** Examples: `allowed_actions`, `capabilities`, `payment_status`, `stock_check`, `stock_status`, and later `deadline_flag` (PB 16). A new client then renders these fields and re-implements nothing.
3. **Frontend non-UI code goes in `Frontend/src/lib/`:** API client, socket client, connection watcher, formatters, constants. It has no React imports and no DOM styling, and must run unchanged in Next.js client components and in React Native.
   - Existing `api.js` and `config.js` stay where they are until they are next touched.
   - At migration time, `VITE_API_URL` becomes `NEXT_PUBLIC_API_URL`, or the Expo equivalent.
4. **Colours and visual states come from status tokens.** For example, `stock_status: 'low_stock'` maps to a colour in one place per component. Swapping the inline style objects for Tailwind classes is then a mechanical change.
5. **No new UI dependencies** beyond `lucide-react` (which has a React Native port, `lucide-react-native`).
6. **Contract tests protect the migration.** The backend tests in `Backend/tests/` describe the API. A migrated client is "done" when it passes the same manual UAT script against the same API.

### Known migration risks (to plan before the final sprint)

- **Offline on mobile.** The offline cache lives where the **backend** runs: SQLite, next to Express. A branch computer that runs the backend works through brownouts. A phone talking to a cloud-hosted backend does not. The final design must either run the backend per branch, or add an on-device cache to the mobile app (for example Expo SQLite) that replays writes through the same API.
- **Hosting.** The Socket.io and `LISTEN/NOTIFY` features need a long-running Node process, not serverless functions. Host Express separately from the Next.js site, or use a Next.js custom server.
- **Schedule.** UAT (Sprint 16) is 2026-10-29 → 2026-11-07. The migration must be scheduled explicitly with the adviser. It is not in the current sprint dates.

---

## 4. Architecture to keep (summary)

- **Writes are cloud-first.** Only `isConnectionError(err)` may fall back to SQLite, through `withLocalTransaction(req.localDbPath, fn)`. Never run BEGIN on the shared `req.localDb`.
  - Offline rows get `sync_status = pending_insert` or `pending_update`.
  - `offlineUpdateBookkeeping()` records `dirty_fields`.
  - Offline stock deltas use the `cloud_stock_delta` pattern.
- **Transactions:**
  - `withPgTransaction` holds one client.
  - Rows are locked `FOR UPDATE` in primary-key order.
  - Checks run on the locked rows.
  - Writes are guarded in SQL and their `rowCount` is asserted.
  - `err.commitUnknown` returns 503 `COMMIT_UNKNOWN` and never falls back offline.
- **Cloud-only operations** (503 offline): approve, status change, adding a stock-linked item to a reserved order, purge, account changes. **Consumable deduction (PB 15) rides on status changes, so it is cloud-only too.**
- **Stock model:**
  - `quantity_available` is on hand, and `quantity_reserved` is promised to orders.
  - Free stock is `available − reserved`.
  - Creating a Pending order reserves its stock, cancel releases it, and complete consumes it.
- **Real-time:** call `req.inventoryEvents.notifyChanged(ids, reason)` after every stock change. Never change the `inventory_updated { reason, changed_ids, snapshot }` shape.
- **Auth:** the role comes from the JWT. Ranks are Owner > Admin > Production > Staff. Account changes set `users.tokens_valid_after`.

---

## 5. PB 15: Deduct Consumables (Sprint 12)

**Story:** As the system, I want to automatically deduct calculated ink/thread upon status updates, so that manual memory tracking is eliminated.

**UAC:**
- Triggered by specific status shifts (e.g., shifting to "Printed").
- A formula applies the estimated consumable loss.
- The Inventory DB is updated automatically.

### Needed from the client before coding (blocking)

- The list of consumables: each ink colour, transfer paper, thread, and so on, with the unit each is counted in (ml, sheets, cones).
- The usage rate per piece for each product type: for example, ml of ink per printed shirt, by size if it differs.

### Proposed design (confirm with the team)

- **Consumables are ordinary `inventory_items`** with `item_category = 'Consumable'` and a `unit`. They get the existing low-stock alerts (PB 17), Catalog, audit trail and Recycle Bin for free.
- **New table `consumable_rates`:** `rate_id`, `product_inventory_id` (the blank, e.g. "White Shirt L"), `consumable_inventory_id`, `quantity_per_piece` NUMERIC, `trigger_status` (`Pressing` or `Completed`), `last_modified`, `sync_status`.
  - Owner/Admin edit it.
  - It syncs as a parent of nothing; place it after `inventory_items`.
- **Trigger:** the transition *out of* `Printing` (to `Pressing`, or to `Completed` when pressing is skipped) deducts printing consumables. Rates with `trigger_status = 'Completed'` deduct on completion.
- **Formula:** `deduct = Σ over linked order_items (quantity × quantity_per_piece)`, computed in SQL as NUMERIC and rounded up to the consumable's unit precision.
- **Transaction:** the deduction runs in the **same** `withPgTransaction` as the status change.
  - Lock consumable rows `FOR UPDATE` by `inventory_id`.
  - Write one `inventory_audit_log` row per consumable (`action = 'consumable_deducted'`, with `order_id`).
  - Call `notifyChanged`.
- **Exactly once:** each order and trigger is marked (`order_consumables_log` with a UNIQUE (`order_id`, `trigger_status`)), so a retry or a repeat transition never deducts twice.
- **Estimates must not block real work (decision needed):** if the estimate is larger than what is on hand, the status change still succeeds. Stock is reduced to 0 (the stock-never-negative rule holds), the shortfall is recorded in the audit row, and the item appears as out of stock in PB 17's warning.
- **Screens:** a "Usage rates" section in the Catalog edit modal for blanks (Owner/Admin). The order pop-up's status timeline (Batch 3.2) shows what was deducted.

### Tests

- The rate × quantity math, including mixed sizes and several consumables.
- Exactly-once deduction under a retried request.
- Rollback: a failure after the deduction leaves no stock change and no audit row.
- Offline status change gives 503 and deducts nothing.
- `inventory_updated` carries the consumable ids.
- A shortfall clamps to 0 and is audited.

---

## 6. PB 17: Notify Low Stock (Sprint 12)

**UAC:** continuously monitors `quantityAvailable`; if it is below `minimumThreshold`, pins a yellow warning to the Owner dashboard.
**SIA 1:** the warning stays on the Owner's and Staff's dashboards until a Receive Restock is performed.

**Already built:**
- `stock_status` (`low_stock` / `out_of_stock`) is computed from free stock against `minimum_threshold`.
- The Dashboard "Needs restocking" card.
- Live `inventory_updated` pushes.
- Add stock through `POST /api/inventory/:id/adjust`, which is the Receive Restock use case.

**Remaining:**
- **Batch 1.5:** the pinned yellow banner.
- After PB 15 lands, consumables appear in the same warning automatically.
- Nothing else is needed. The warning is derived from current stock, so restocking clears it without any "dismiss" state.

---

## 7. Content moved here from the earlier draft (for the right sprints)

The earlier draft's designs remain valid. They now belong to these backlog items. **Items marked ⚠ go beyond the UAC and need client approval before they are built.**

| Earlier draft section | Correct backlog item | Notes |
|---|---|---|
| "Damaged / misprint logging": `loss_type` (`lost`, `damaged`, `misprint`), misprint linked to an Approved/Printing order, `evidence_link` (Drive link) | **PB 18** Record Material Loss (Sprint 13) | UAC: a form, a required reason code and quantity, deducted permanently. Reason codes replace free text. |
| ⚠ Two-step report → verify/reject, where the reporter can't verify | PB 18 (addition) | The UAC deducts immediately on report. A verification step changes that, so ask Ana Marie. |
| `financial_cost = quantity × unit_cost` in SQL NUMERIC, "Waste this month" (₱, centavos), `waste.csv` export | **PB 20** Log Financial Waste Cost (Sprint 13) | The cost is already stored. Remaining work is the reports and the dashboard. It feeds PB 22. |
| **D1:** a misprint uses general stock, not the order's reservation (`available −= qty`, reserved untouched, refused unless free stock ≥ qty) | PB 18 | Keep this rule. |
| Archive orders/customers (never hard delete), `ORDER_STILL_OPEN`, `RECORD_ARCHIVED`, `include_archived` | **PB 23** Void Transaction (Sprint 14), plus housekeeping | **D2:** archived records are kept forever. The 30-day purge stays limited to the inventory Recycle Bin. |
| Payment voids as reversing entries (`voids_payment_id`, one void per payment, `VOID_BREAKS_DOWNPAYMENT`) | **PB 23** | **D3:** payments are never edited or deleted, only voided. The UAC also asks for the cancellation reason and the financial record marked "Voided". |
| General append-only `audit_log` (entity, action, before/after JSONB, performer, role), plus `GET /api/audit` for Owner/Admin | Supporting work for **PB 5** (Batch 3.5), **PB 12** (override log) and **PB 23** (cancellation reason) | Created in Batch 3 (migration `009`), where it is first needed. `inventory_audit_log` stays separate. |
| **D4:** reporter ≠ verifier | PB 18 (only if verification is approved) | — |

---

## 8. Open questions (answer before the matching batch)

1. ~~Batch 1.2: Owner-only excludes Admin?~~ **Yes** (answered 2026-10-29).
2. ~~Batch 1.3: tracking number format?~~ **`XM-2026-0123`, restarting each year.**
3. ~~Batch 1.1: logout scope?~~ **This device only.**
4. ~~Batch 1.6: add CI now?~~ **Yes.**
5. **Batch 2.3:** Is "payment acknowledgement receipt" (not a BIR OR) acceptable? What should happen when two offline branches together overpay?
6. **Batch 3.1:** Can orders skip Pressing (e.g. mugs), going Printing → Completed?
7. **PB 15:** Consumable list, usage rates, and the "never block a status change" rule.
8. **PB 18:** Immediate deduction (UAC), or a report → verify flow?
9. **Branches:** 2 (SIA 1) or 3 (SoftEng proposal, UAT)? This affects UAT device count and deployment.

## 9. Out of scope for this sprint

- The Next.js / Tailwind / mobile migration itself (§3 only sets the rules).
- PB 11, 12, 16, 18–23 and 26–27 feature work, except the remediation listed in §2.
- Hard deletion of anything except inventory items through the existing Recycle Bin.
- Photo upload for evidence. Use Google Drive links.
