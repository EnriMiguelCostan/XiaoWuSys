Here is the master context steering file for the XiaoWuSys repository. Please review and acknowledge.

# XiaoWuSys: master context steering (after Batch 1 + Batch 2)


 Onboarding document for a new AI session. Read this whole file before changing any code.
 Repository: EnriMiguelCostan/XiaoWuSys. App root: XiaoWuSys-main/ (Backend/, Frontend/, docs/).
 Also read: XiaoWuSys-main/docs/sprint-12-steering.md (backlog map, Batch 1 and Batch 2 "as built" notes, Batch 3 plan, open questions) and .kiro/steering/architecture.md.
---


## 1. Current state


main is at **805a619**: the merge of **PR #16 (Batch 2)**, on top of **PR #15 (Batch 1)**. Check with git log --oneline -5.
Migrations 001–010 exist. **Never edit them.** 009 and 010 are Batch 3 (built in Batch M6, see sprint-12-steering.md §2 "As built"). The next one is 011 (PB 15).
CI (.github/workflows/ci.yml) was green at the end of Batch 2:
  - Backend: npm ci && npm test with a PostgreSQL 16 service and TEST_DATABASE_URL. **115 tests pass, 0 are skipped**, including two real-PostgreSQL suites.
  - Frontend: npm ci, npm run lint and npm run build.
Done: PB 1 (logout), 2 (roles), 3 (offline cache + connection watcher), 4 (async sync + reconnect + Sync now), 6 (order numbers), 9 (stock check), 13 (approve), 17 (low-stock pin) and 21 (payments).
Next is **Batch 3** (migration 009, see sprint-12-steering.md §2):
  - PB 14: a "Pressing" step, order_status_history and live order_updated events;
  - PB 5: the screens use edit locks, an Owner override with audit_log, and offline conflicts are resolved by rank with POST /api/sync/conflicts/:table/:id/resolve.
After Batch 3 comes PB 15 (consumables, including the **inventory units refactor**, postponed there on purpose).
**Not built yet, by team decision:**
  - dark mode (waits for the Next.js + Tailwind move; the theme stays hard-coded light);
  - refunds and voids (PB 23);
  - P&L (PB 22);
  - quotes and discounts (PB 11/12).


---


## 2. Ground rules (non-negotiable)


1. **Read before you write.** Open the files you will touch and reuse the existing helpers (records.js, validation.js, dbErrors.js, localSync.js, services/domain/*, shared/client-core/*). Never re-implement them.
2. **Every business rule lives on the server**, as pure functions in Backend/services/domain/ where possible (no Express, no SQL). Routes stay thin: validate, call the service, serialize.
3. **The API returns decisions, not raw data the client must interpret.** Examples: capabilities, allowed_actions (which buttons to show, max_payment, payment_blocked_reason), stock_check, stock_status, payment_status, remaining, downpayment and sync_status. Clients never recompute rules. The server re-checks every action.
4. **Client non-UI code goes in shared/client-core/** (package @xiaowu/client-core, Batch M0), as plain JS with no React and no DOM, plus a .d.ts per module. Frontend/, Web/ and the future React Native app all import it. Relative imports keep their .js extension.
5. **Styling in Frontend/ (Vite MVP, frozen since Batch M0: bug fixes only):** React inline styles only. lucide-react is the only UI dependency allowed (no Tailwind, no UI libraries). Each component keeps one style object at the bottom of its file. Visual states map to style tokens in one place (e.g. CONNECTION_STYLE[state], PAYMENT_STATUS_META). Form controls set color: '#0f172a', backgroundColor: '#fff' and colorScheme: 'light'.
   **Styling in Web/ (Next.js):** Tailwind + shadcn/ui only. State colours come from Web/lib/ui-tokens.ts and app/state-tokens.css; components never pick colours for states. `npm run check-rules` in Web/ enforces the server-decides rules (steering §6).
6. **Errors are structured JSON:** { error: 'MACHINE_CODE', message: 'Plain sentence for printshop staff', ...details }.
   - Database errors **always** go through sendDbError(res, err, '<context>') from utils/dbErrors.js.
   - Business failures inside a transaction are thrown as new Rejected(status, body) (class in routes/orders.js) and sent as-is.
   - Everything else falls to the global handler in app.js.
   - Add an entry to FRIENDLY_ERRORS in Frontend/src/api.js only when the server text would be technical.
7. **Validation:** use strict createValidator(). Numbers must be JSON numbers (the string "5" is rejected). Money has at most 2 decimals and stays at or below 99,999,999.99. IDs match ID_PATTERN.
8. **Never weaken these guarantees:**
   - the role comes **from the JWT only** (requireRole(rolesWith(cap)) and can(role, cap));
   - optimistic concurrency with expected_version and the last_modified trigger;
   - stock never goes negative;
   - offline fallback happens **only** on isConnectionError(err) (audit C5);
   - err.commitUnknown returns 503 COMMIT_UNKNOWN and **never** falls back offline;
   - all SQL is parameterised;
   - money is compared in **integer centavos**;
   - the Owner-only rules stay as they are.
9. **Schema changes:** one new idempotent migration per batch, using IF NOT EXISTS, CREATE OR REPLACE and DROP TRIGGER IF EXISTS. Mirror every change in **all** of these places:
   - services/localSchema.js (new SQLite caches);
   - TABLE_EXTRA_COLUMNS in utils/localSync.js (existing local_cache.db files);
   - ENTITIES in services/records.js;
   - SYNC_TABLES in services/sync.js;
   - EXTRA_COLUMNS and EXPECTED_TRIGGERS in services/schemaCheck.js.
10. **Tests:**
    - Every new route gets tests in Backend/tests/ using startTestServer() (offline SQLite) or a scripted pgPool (see tracking-sync.test.js and payments-sync.test.js).
    - Anything that relies on row locks or triggers gets a real-PostgreSQL test that runs only when TEST_DATABASE_URL is set. Use tests/helpers/pgTestServer.js. Its safety guard allows localhost or a database name containing "test" only. **Never Neon.**
    - Run a mutation check before opening a PR: break the rule and confirm the new tests fail.
11. **Wording on screen:** plain English for non-technical staff.
    - No field names and no raw IDs. Use XM-2026-0123, or "New order" until an offline order syncs.
    - No time-zone codes.
    - Never use the word "BIR".
12. **Git:**
    - Work on a new branch off main (e.g. feat/batch3-...). Never commit to main; it needs 1 approving review.
    - Never commit node_modules/, .env, *.db or the sandbox stand-ins.
    - Open PRs with gh api repos/EnriMiguelCostan/XiaoWuSys/pulls -f title=... -F body=@file -f head=<branch> -f base=main. gh pr create does not work here.
    - The PR description lists what was and wasn't checked by hand.
13. **Agent sandbox limits:**
    - npm ci returns 403. Batch 1 and 2 used small stand-ins for express, jsonwebtoken, bcrypt, sqlite3 (built on node:sqlite), cors and dotenv in /projects/sandbox/.shims/node_modules, **outside the repo**. Run tests with NODE_PATH=/projects/sandbox/.shims/node_modules npm test. They may be gone in a new sandbox; rebuild them if needed and never commit them.
    - There is no PostgreSQL in the sandbox, and pg/socket.io can't be loaded, so the PostgreSQL suites skip locally.
    - **CI is the real check.**
    - gh run fails here. Use the REST API instead:
      - gh api "repos/EnriMiguelCostan/XiaoWuSys/actions/runs?branch=<b>&per_page=1"
      - .../actions/runs/<id>/jobs
      - .../actions/jobs/<job_id>/logs
    - Known quirk: node --test tests/tracking-sync.test.js **alone** fails with a test-runner IPC error in the sandbox. It fails the same way on main, and it passes in the full run and in CI.


---


## 3. Architecture and stack
Backend/   Node 22, Express 5, pg (Neon PostgreSQL = source of truth), sqlite3 (offline cache), Socket.io
  app.js          createApp({ pgPool, localDb, localDbPath, orderLocks, inventoryEvents, syncAndNotify,
                  listConflicts, cloudHealth, onLocalWrite, corsOrigins }), shared by server.js and the tests.
                  Inject every new service here so tests can supply stubs.
  server.js       start-up: wraps the pool with cloud health, socket auth, sync timer, migrations, schema check
  routes/         auth, orders, inventory, customers, reports (dashboard + CSV exports)
  services/       sync.js, cloudHealth.js, records.js, sessions.js, capacity.js, recycleBin.js, inventoryEvents.js,
                  localSchema.js, migrations.js, schemaCheck.js, orderLocks.js, cloudDisabledPool.js
    domain/       permissions.js, orderLifecycle.js, stockCheck.js, payments.js (pure rules)
  migrations/     001–008 (applied automatically on start; npm run migrate)
  tests/          node:test; helpers/testServer.js (offline), helpers/pgTestServer.js (real PG), fixtures/data.js
Frontend/  React 19 + Vite + inline styles = MVP/Beta, frozen since Batch M0. Replaced by Web/ (see docs/nextjs-migration-steering.md).
  src/App.jsx, OrdersPage.jsx, Dashboard.jsx, InventoryCatalog.jsx, UsersPage.jsx, Dialogs.jsx (ResultDialog,
  ConfirmDialog), api.js (createApi never throws; status 0 = server unreachable; errorText, peso, formatDateTime)
shared/client-core/  permissions.js, orders.js, connection.js, receipt.js, api.js, format.js, csv.js, config.js (plain JS + .d.ts)
Web/       Next.js App Router + TypeScript + Tailwind + shadcn/ui. UI only: no API routes, no DB, no secrets.
**Writes are cloud-first.**
writeCloudFirst() or a withPgTransaction() path runs first. Only on a connection error does the route fall back to withLocalTransaction() / SQLite with sync_status = 'pending_insert' | 'pending_update', dirty_fields, and last_modified = LOCAL_NOW (milliseconds).
listRecords() reads the cloud and also merges local pending_insert rows, so a record never "disappears" before it syncs.
serialize() gives the same JSON shape from either database.
Each response says source: 'cloud' | 'local'.
**Online-only actions** return 503 when the cloud is unreachable, never falling back: approve, status changes (they move shared stock), account management, and permanent delete.


**Stock:** "free to use" = quantity_available − quantity_reserved.
Orders reserve stock in the same transaction that creates them.
Cancel releases the reservation; Complete consumes it.
Stock rows are locked FOR UPDATE ORDER BY inventory_id, so concurrent orders can't deadlock.
**Real time:**
Socket.io is authenticated with the JWT, and revoked sessions are refused.
Events:
  - inventory_updated, from Postgres NOTIFY through a dedicated LISTEN client in inventoryEvents.js plus this server's own writes;
  - locks_snapshot, order_locked, order_unlocked and order_lock_revoked, for edit locks (server side built, screens wired in Batch 3);
  - sync_status (Batch 2).
Frontend polling (30 s) runs **only while the socket is disconnected**. Never add polling while the socket is live.
**Offline-only mode:** CLOUD_DISABLED=true or no DATABASE_URL swaps in cloudDisabledPool.js, which always answers ECONNREFUSED. npm run demo and the tests use it.


---


## 4. Batch 1 and Batch 2 mechanics (don't break these)


### 4.1 Sequential numbers: XM-YYYY-NNNN (orders, migration 007) and AR-YYYY-NNNN (payments, migration 008)


Both use the same pattern.
**Counter table, not a SEQUENCE:** order_tracking_counters / receipt_counters hold (year PK, last_number).
next_order_tracking_no(ts) / next_receipt_no(ts) work out the **Asia/Manila** year from a UTC timestamp, then run INSERT ... ON CONFLICT (year) DO UPDATE SET last_number = last_number + 1 RETURNING.
  - The counter row stays locked until the transaction ends, so two inserts at the same moment get different numbers.
  - A rollback undoes the increment, so a rollback leaves **no gaps**.
**BEFORE INSERT OR UPDATE triggers:** trg_order_profiles_assign_tracking_no and trg_payments_assign_receipt_no.
  - They are named so they fire before trg_<table>_last_modified.
  - On INSERT the trigger **always** assigns a number and ignores any value the client sent.
  - On UPDATE it keeps the old number. A number never changes once set.
**Backfill:** each migration numbers existing rows oldest first (ORDER BY date NULLS FIRST, id) before creating its trigger, so running it twice changes nothing.
**Sync:** SYNC_TABLES lists these columns as cloudOwned: ['tracking_no'] / ['receipt_no'].
  - Cloud-owned columns are **never pushed**.
  - After a push they are read back from Neon and copied into the local row (markAsSynced / keepPendingAfterPush).
  - For tables with cloud-owned columns, pushInsert first checks SELECT 1 ... WHERE id = $1 and skips the INSERT if the row is already in Neon. Without that check, a resent row would fire the trigger and burn a number.
**Offline display:** no number yet. Orders show "New order", and NUMBER_AFTER_SYNC in shared/client-core/orders.js explains why. Payments show "Given after sync".
GET /api/orders?tracking_no=XM-2026-0123 searches by number (v.trackingNo).
order_id and payment_id stay UUIDs, because sync and foreign keys depend on them.
### 4.2 Owner-only financial permissions (JWT)


services/domain/permissions.js holds the CAPABILITIES table, with can(role, cap), rolesWith(cap) and capabilitiesFor(role).
  - **Owner only:** set_quote, apply_discount (reserved for PB 12), void_order (Cancel), approve_order. The Admin is blocked too.
  - **Owner, Admin, Production:** create_order, edit_order, change_status, record_payment.
  - **Owner, Admin:** view_finance, manage_accounts.
  - **Everyone:** view_orders.
The role is read **only** from the verified JWT (req.user.role), never from the body or the client.
Errors:
  - 403 QUOTE_OWNER_ONLY when a non-Owner sends a non-zero total_quote_amount on create, or any total_quote_amount on PATCH /:id/details. A non-Owner may still send 0 ("no price yet").
  - 403 VOID_OWNER_ONLY when a non-Owner sends status Cancelled. The capacity-halt "Cancel" choice while creating an order stays open, because nothing is reserved or paid at that point.
  - Approve is requireRole(['Owner']).
The quote is frozen from Approved on (QUOTE_FROZEN_STATUSES), because the downpayment was checked against it.
Approve (POST /api/orders/:id/approve, online only, one transaction) requires, in this order:
  1. a required expected_version;
  2. a status of Pending or Delayed;
  3. a quote above 0;
  4. at least **50% downpayment in centavos, counting Neon payments only** (ceil(quote/2)). **Leave this check unchanged;**
  5. at least one item, with every item linked to stock;
  6. enough free stock (with locked rows).
Login and GET /api/auth/me return capabilities.
GET /api/orders/:id returns allowed_actions from orderLifecycle.allowedActions(order, role, paymentSummary). The frontend uses orderActions(detail) and can(user, cap) from shared/client-core/permissions.js only to show or hide buttons.
### 4.3 Device-specific logout (PB 1)


Login tokens carry sid (session id, a UUID), ims (issue time in ms), user_id and role. They last 8 hours and use HS256.
POST /api/auth/logout writes revoked_sessions (session_id, user_id, expires_at, revoked_at) to Neon. When offline it writes a SQLite pending_insert row; this table is push-only in sync and never refreshed down.
services/sessions.js keeps revoked sids and per-user cut-offs in memory, so verifyToken stays synchronous.
  - Cut-offs come from users.tokens_valid_after / is_active.
  - Memory is loaded at start-up and refreshed every minute.
  - isTokenRevoked(payload) covers both cases.
onSessionRevoked(sid) disconnects only that device's sockets. Other devices stay signed in.
Deactivating an account, changing its role or resetting its password sets tokens_valid_after, which signs that account out everywhere.
Tokens issued before Batch 1 have no sid and simply expire.
### 4.4 Connection watcher and automatic single-flight sync (PB 3 / PB 4)


**services/cloudHealth.js, createCloudHealth({ pgPool, cloudDisabled, probeMs, onChange, onReconnect }):**
**States:**
  - unknown: before the first query result;
  - reachable;
  - unreachable;
  - disabled: offline-only mode; it never changes.
**Signals:** watchPool(pool, health) wraps pgPool.query and pgPool.connect in server.js, including the clients that connect() returns. Every outcome is reported and passed through unchanged, in both promise and callback styles.
  - Only isConnectionError(err) counts as a failure; data errors are ignored.
  - Routes did not change.
  - The LISTEN client in inventoryEvents.js is **not** wrapped.
**Probing:**
  - **Never while reachable (D3)**, so Neon can auto-suspend.
  - Only while unreachable: SELECT 1 every CLOUD_PROBE_MS (default 15000), on a timer with unref().
**Reconnect:** onReconnect() fires **exactly once** per unreachable → reachable flip. server.js then runs syncAndNotify().
**Sync (services/sync.js):**
syncOfflineData() is **single-flight**: a second call while a run is in progress joins the running promise (joined: true). The reconnect sync, the 5-minute timer, the start-up sync and POST /api/sync can therefore never overlap.
Tables are pushed parents first: users (pull-only), revoked_sessions, inventory_items, customers, order_profiles, then order_items / payments / material_loss / inventory_audit_log.
  - pending_insert rows are pushed with ON CONFLICT DO NOTHING.
  - pending_update rows push **only dirty_fields**, and only if the Neon last_modified still matches cloud_last_modified. Otherwise the row is marked sync_conflict and never overwritten.
A row is marked synced only if its local last_modified did not change during the push (H3).
After pushing, the sync refreshes parent and child tables from Neon. Rows with local changes or conflicts are never overwritten.
A connection error mid-run aborts the run (aborted: true).
lastSync:
  - last_sync_at moves only on a run that reached the cloud;
  - last_sync_result is the latest run of any kind: ok, conflicts or aborted.
countPending(localDb) counts pending_* rows with sync_conflict IS NULL, per non-pull-only table.
buildSyncStatus() builds the body shared by **GET /api/sync/status** (any login) and the **sync_status** socket event:
  { cloud, cloud_since, last_sync_at, last_sync_result, syncing, pending: {table: n}, pending_total, conflicts }.
server.js emits sync_status:
  - when a socket connects;
  - on every cloud-state change;
  - before and after every sync;
  - after any non-GET response with source: 'local' (onLocalWrite, debounced 500 ms).
GET /api/status (no login) adds cloud. Never add URLs or secrets to it.
POST /api/sync returns 200, 409 SYNC_CONFLICT or 503 CLOUD_UNREACHABLE. Keep this contract.
GET /api/sync/conflicts (Owner, Admin) only lists conflicts. Resolving them is Batch 3.
**Frontend:**
shared/client-core/connection.js:
  - deriveConnectionState({ serverReachable, cloud }) returns online, offline_local ("Offline: saving on this computer"), server_down ("Can't reach the shop server") or checking;
  - also exports connectionText, pendingText, syncDisabledReason and syncResultMessage(status, body).
App.jsx shows a sticky status bar under the header with:
  - the state, using CONNECTION_STYLE[state] tokens and aria-live="polite";
  - the "N changes waiting to sync" badge;
  - a conflict count for Owner/Admin;
  - **Sync now**, which is disabled while a sync runs or the server is down, with a tooltip saying why. Every result ends in a ResultDialog.
/api/sync/status is fetched on login, when the socket drops, on browser online / offline events (hints only), after Sync now, and every 30 s **only while the socket is disconnected**.
### 4.5 Payments (PB 21): limits, provisional receipts, Overpaid


**Migration 008:**
payments.received_by VARCHAR(50) with an FK to users ON DELETE SET NULL. Old rows are NULL and shown as "Not recorded".
payments.receipt_no: see §4.1.
An index on payments(order_id).
**No CHECK (amount > 0), on purpose:** PB 23 will record voids as negative reversing entries.
**Pure rules (services/domain/payments.js, all in centavos):**
paymentSummary({ quote, payments }) returns { quote, total_paid, remaining, overpaid_by, payment_status, downpayment: { required, paid_synced, met } }.
  - payment_status:
    - paid = 0: Unpaid;
    - 0 < paid < quote: Partial;
    - paid = quote: Fully Paid;
    - paid > quote, or paid > 0 with a quote of 0: Overpaid.
  - The payment status is **separate from production_status (D4)**. Never add these values to the production status CHECK.
  - downpayment.required = ceil(quote/2), counting **synced payments only**.
checkPayment({ status, quote, paid, amount }) returns null or { status, body }, in this order:
  1. Cancelled: 409 ORDER_CLOSED (Completed is allowed; the final balance is often paid at pickup);
  2. quote ≤ 0: 422 QUOTE_REQUIRED;
  3. amount > remaining: 409 PAYMENT_EXCEEDS_BALANCE { remaining, total_paid, total_quote_amount }, with the message "The most this order can take now is ₱X (the remaining balance)."
downpaymentWarnings() is non-blocking and applies only to Pending or Delayed orders:
  - DOWNPAYMENT_SHORT: all payments together are still below 50%;
  - DOWNPAYMENT_NOT_SYNCED: 50% is reached only through payments not yet synced.
runningTotals() gives each payment paid_to_date, remaining_after and status_after, used by the receipt.
paymentBlockedReason() explains, in plain words, why the payment form is hidden.
**POST /api/orders/:id/payments, body { amount, payment_type }:**
A body that sends received_by or receipt_no gets 400 VALIDATION_FAILED. received_by is always req.user.user_id.
**Cloud path:** one withPgTransaction.
  1. Lock the order: SELECT ... FROM order_profiles WHERE order_id = $1 FOR UPDATE.
  2. Sum the Neon payments in centavos and run checkPayment.
  3. Insert with a **SQL guard** (INSERT ... SELECT ... WHERE quote − paid ≥ amount, all in centavos) and assert rowCount === 1.
  - Two simultaneous payments are serialised by the order lock: one gets 201, the other 409 (proved on real PostgreSQL in payments.pg.test.js).
**Offline path:** taken only on a connection error, or when the order exists only locally.
  - Runs the same checkPayment against the **local** view, which includes pending_insert payments.
  - Inserts a pending_insert row with received_by, payment_date = LOCAL_NOW (milliseconds) and **no receipt_no**.
The response carries { message, source, payment (with received_by_name), totals, allowed_actions, warnings }.
**D2, offline overpayment:**
Each branch caps a payment against what it can see.
When they sync, **every payment is pushed with no cap**; sync never drops or refuses a payment. The cloud then assigns each receipt_no.
If branches together overpaid, the order becomes **Overpaid**:
  - the dashboard returns orders.overpaid[] and overpaid_total, filled only for view_finance roles (Owner, Admin; others get []), shown as the "Overpaid: review and refund" panel;
  - the order detail shows a red warning.
The Owner refunds by hand. Refunds and voids are PB 23.
**Reads:**
GET /api/orders/:id and GET /:id/payments:
  - payments are sorted by payments.payment_date, payments.payment_id. Use the qualified column: the SELECT alias is cut to whole seconds;
  - each payment carries received_by_name (cloud users first, then the local pull-synced copy, via records.userNames), paid_to_date, remaining_after and status_after;
  - totals adds remaining, overpaid_by, payment_status and downpayment. balance keeps its old meaning (quote − paid, negative when overpaid).
allowed_actions:
  - record_payment is false when the order is Cancelled, has no quote, is fully paid, or the role lacks the capability;
  - max_payment is the remaining balance;
  - payment_blocked_reason explains why payments are blocked;
  - print_receipt is true for every view_orders role.
Exports:
  - payments.csv adds **Receipt no.** ("Given after sync" when there is none) and **Received by**;
  - orders.csv adds **Payment status**;
  - an unsynced order is shown as "New order".


**Printable acknowledgement:**
shared/client-core/receipt.js (receiptLines, receiptHtml, receiptText, escapeHtml) builds it. OrdersPage.jsx prints it through window.open + print(), like printJobOrder.
It shows:
  - the title "XiaoMei Printshop: Payment Acknowledgement";
  - the receipt number, or **"Receipt number given when the system is back online"** for an offline payment (**provisional**; it can be reprinted with its AR number after sync);
  - the order number, customer, date and time in Manila (no zone code), amount, payment type and received by;
  - quote, total paid, remaining balance and payment status after this payment;
  - the footer: **"This is an acknowledgement of payment, not an Official Receipt."**
Every value is escaped.
**Payment form:** max and the placeholder come from allowed_actions.max_payment, with a **Pay full balance** button. A PAYMENT_EXCEEDS_BALANCE response shows the server's message, and warnings appear in the success dialog.


---


## 5. Key decisions log


**D1:** the receipt is a "Payment Acknowledgement", not a BIR Official Receipt (SIA 1 says the system does not issue ORs).
**D2:** offline overpayments are all accepted on sync. The order shows Overpaid and the Owner refunds by hand.
**D3:** no probing while the cloud is reachable.
**D4:** the payment status is separate from the production status.
**P1–P4:** AR numbers per Manila year from the cloud; provisional offline receipts; Cancelled refuses payments and Completed accepts them; a payment needs a quote above 0.
**Owner-only** includes blocking the Admin. Logout ends the current device only.
**Postponed:** dark mode (until Next.js + Tailwind) and inventory units (PB 15).
**Open questions** (sprint-12-steering.md §8):
  - Can orders skip Pressing (Printing → Completed)?
  - PB 15: the consumables list and usage rates.
  - PB 18: immediate deduction, or report → verify?
  - Number of branches: 2 or 3?


---


## 6. Manual checks still to do (not possible in the agent sandbox)


npm run demo: the bar shows "Offline: saving on this computer". Try Sync now (expect "Still offline"), a payment, the cap, Pay full balance and a provisional receipt.
Point DATABASE_URL at postgresql://u:p@127.0.0.1:1/db: the bar should flip to Offline. Restore it: within about 15 s the bar should return to Online and the sync should run on its own.
Against Neon: expect ✓ Applied migration 008_payments_receipts.sql once and nothing on the next restart. Existing payments should be numbered AR-YYYY-NNNN.