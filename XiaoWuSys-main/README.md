# XiaoWuSys

Inventory and order management for **XiaoMei Printshop** (Agdao, Davao City). It replaces the stock whiteboard, the order notes kept in Messenger, and the Excel / Google Sheets logs. Capstone project, Software Engineering 2.

## What it does

| Area | Features |
|---|---|
| **Catalog** | Sortable stock table with live updates. Each item has a unit (pcs, pack, ream…), a supplier and a low-stock alert. **Add / Subtract Stock** with a reason; lost or damaged stock is recorded with its cost. Duplicate names are blocked, ignoring case and spaces. Edit items, delete them to the **Recycle Bin** (restorable), **import from Excel** (CSV) and **export to Excel**. |
| **Orders** | Create an order for a saved or new customer (11-digit mobile number). Every order gets a sequential **order number** like `XM-2026-0123` that restarts each January (an order saved offline gets its number when it syncs); search by it in the Orders tab. Stock is checked and **reserved** automatically; a halted order can be delayed or cancelled. The order detail shows materials, print details (size / name / number), the Google Drive design link and payments. **Payments** can't go above the remaining balance (**Pay full balance** fills it in). Each payment records who received it and gets an acknowledgement number like `AR-2026-0001`; a payment saved offline gets its number when it syncs. Every order shows a payment status (**Unpaid**, **Partial**, **Fully Paid** or **Overpaid**) separate from its production status. Staff are warned when the downpayment is still below 50%. **Print receipt** prints a payment acknowledgement (not an Official Receipt). **Only the Owner** sets or changes the quote and cancels an order; a payment needs a quote, and a cancelled order takes no payments. Status runs Pending → Approved (Owner only, needs a 50% downpayment) → Printing → Completed. Approve and Resume are greyed out, with the reason, while the free stock does not cover the order. **Copy for Messenger** and **Print job order** buttons. |
| **Dashboard** | A **yellow low-stock warning** pinned at the top while any material is at or below its alert level (it updates live and disappears after restocking). Overdue orders, orders due this week, unpaid balances, an **Overpaid: review and refund** list for the Owner and Admin, payments per month, most-used materials, and a **restock list** with suggested quantities (copyable). Inventory, order and payment exports. |
| **Accounts** | The Owner / Admin create accounts, change roles, reset forgotten passwords and deactivate staff who left. Everyone can change their own password. |
| **Offline** | If the internet drops, the system keeps working on a local copy and syncs **automatically** when the connection returns. A bar under the header always shows **Online**, **Offline: saving on this computer** or **Can't reach the shop server**, how many changes are waiting to sync, and a **Sync now** button. While online the server never checks the cloud on its own, so Neon can still sleep when the shop is idle; it checks every 15 seconds only while the cloud is unreachable. Accounts that have logged in on that computer can log in offline. |
| **Traceability** | Every catalog change is written to a hidden, append-only audit trail (`npm run audit-log`). |

### Roles

| Role | Can do |
|---|---|
| Owner | Everything, including the money decisions only the Owner makes: setting or changing quotes, cancelling (voiding) orders and approving job orders; manages Owner accounts |
| Admin | Everything except the Owner's money decisions (quotes, cancelling orders, approving); manages non-Owner accounts |
| Production | Catalog, stock and orders |
| Staff | View the catalog, orders and dashboard |

## Quick start

You need **Node.js 22 or newer**. The system is two programs on the shop computer:

| Program | Folder | Address | What it does |
|---|---|---|---|
| API | `Backend/` | port **5000** | Express: every rule, the databases, sync, real-time updates |
| Screens | `Web/` | port **3000** | Next.js: the pages staff use (no data or secrets of its own) |

Staff open **http://localhost:3000** on the shop computer.

### Once per computer

```bash
cd Backend && npm ci
cd ../Web && npm ci
```

### Option A: demo mode (no Neon account needed)

Windows: double-click `scripts\start-shop.cmd` after adding `-Demo`, or run in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-shop.ps1 -Demo
```

macOS / Linux:

```bash
scripts/start-shop.sh --demo
```

The script builds the screens the first time, starts both programs, waits until both answer and opens the browser. Log in as `owner`, `admin`, `production` or `staff`. The password for all of them is **`XiaoMei2026`**.

Demo mode runs fully offline, on its own database file that is never synced. Actions that must reach every branch (approving, status changes, permanent delete, account changes) show the "needs the internet" message.

### Option B: with the cloud database (Neon PostgreSQL)

1. Create a free project at [neon.tech](https://neon.tech) and run `Backend/schema.sql` in its SQL Editor.
2. `cd Backend`, then copy `.env.example` to `.env` and fill in `DATABASE_URL`, `PG_LISTEN_URL` and a long random `JWT_SECRET`.
3. Create the first account:
   ```bash
   ADMIN_USERNAME=owner ADMIN_PASSWORD='YourPassw0rd' ADMIN_ROLE=Owner npm run create-admin
   ```
   On Windows PowerShell, set the variables first:
   ```powershell
   $env:ADMIN_USERNAME="owner"; $env:ADMIN_PASSWORD="YourPassw0rd"; $env:ADMIN_ROLE="Owner"; npm run create-admin
   ```
4. Optional: run `npm run seed-inventory` to add the October 8, 2026 delivery.
5. Start the shop: double-click `scripts\start-shop.cmd` (Windows) or run `scripts/start-shop.sh` (macOS / Linux). Pending database migrations are applied automatically when the API starts.

Keep the start-up window open while the shop is working; closing it (or Ctrl+C) stops both programs. After updating the code, start once with `-Rebuild` (`--rebuild`) so the screens are rebuilt.

**Starting the two programs by hand** (what the script does):

```bash
cd Backend && npm start          # or: npm run demo        -> API on http://0.0.0.0:5000
cd Web && npm run build          # once, and after every update
cd Web && npm run start          # screens on http://0.0.0.0:3000
```

Then open http://localhost:3000. For screen development use `npm run dev` in `Web/` instead of `build` + `start`.

### Tablets on the shop Wi-Fi

Both programs listen on every network address of the shop computer, so tablets and phones on the same Wi-Fi can use the system:

1. Give the shop computer a fixed address on the router (a "DHCP reservation"), e.g. `192.168.1.20`. Otherwise its address can change and tablets lose the connection.
2. In `Backend/.env`, add the tablet address of the screens to `CORS_ORIGINS` (comma-separated, no spaces), then restart:
   ```
   CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.1.20:3000
   ```
   When the API starts it prints the exact entries to add for each network address it has.
3. On the tablet, open `http://192.168.1.20:3000`. The screens find the API at port 5000 of the same address by themselves.
4. If Windows asks, allow Node.js through the firewall on **private** networks.

### The old screens (`Frontend/`)

`Frontend/` is the earlier Vite + React version of the screens (MVP/Beta). It is **frozen** (bug fixes only) and kept for **one release** as a fallback, then removed. If you need it: `cd Frontend && npm ci && npm run dev`, then open http://localhost:5173 (the API allows that address by default). New features are built only in `Web/`.

## Tests

```bash
cd Backend
npm test
```

There are 140 automated tests in `Backend/tests/`. Most start the real API on a throw-away SQLite database filled with the shop's own data (`tests/fixtures/data.js`), with the cloud switched off, and call it over HTTP like the browser does. The sync and connection tests use a small scripted stand-in for the cloud.

`tests/migrations.pg.test.js`, `tests/payments.pg.test.js`, `tests/batch3.pg.test.js` and `tests/m6-part2.pg.test.js` add 42 more that apply `schema.sql` and every migration to a real, throw-away PostgreSQL and check order and receipt numbering, two payments sent at the same moment, the Pressing step and its status history, the Owner override with its audit trail, offline conflicts settled by rank, consumables taken from stock exactly once (also when two screens press the same order at once), the volume quote and the Owner's discount with their audit rows, and the roster import. They run when `TEST_DATABASE_URL` is set, which **wipes that database**, so it must be on `localhost` or have "test" in its name (never Neon):

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/xiaowusys_test npm test
```

**CI:** every push runs the backend tests (with a PostgreSQL 16 service for the migration tests), the `Web/` checks (shared client code tests, the rules guard, lint, type check and build) and the frozen `Frontend/` lint and build on GitHub Actions (`.github/workflows/ci.yml`).

The same checks for the screens, by hand:

```bash
cd shared/client-core && npm test
cd Web && npm run check-rules && npm run check-rules:test && npm run lint && npm run typecheck && npm run build
```

They cover:
- login security: lockout after 5 wrong passwords, forged and expired tokens, deactivated accounts;
- account rules;
- duplicate items;
- stock never going negative;
- the Recycle Bin;
- SQL-injection attempts;
- the audit trail;
- mobile number rules;
- stock reservation by orders and the capacity halt;
- payments: the balance limit (in centavos), receiver, receipt numbers, payment status, the downpayment warning, offline payments that sync with no limit (two branches overpaying shows **Overpaid**);
- the connection watcher (no checks while online, one sync when the cloud comes back) and the "changes waiting" count;
- order editing, and the Owner-only quote and cancel rules;
- order numbers (sync and PostgreSQL numbering) and the stock check before Approve / Resume;
- logging out one device;
- the dashboard and exports (including spreadsheet formula injection);
- security headers and CORS.

## Useful commands (in `Backend/`)

| Command | What it does |
|---|---|
| `npm start` | Start the API |
| `npm test` | Run the automated tests |
| `npm run demo` / `npm run demo:seed` | Start demo mode / rebuild the demo data |
| `npm run migrate` (`-- --list`) | Apply database migrations (or list them) |
| `npm run create-admin` | Create the first account (see above) |
| `npm run audit-log -- --action deleted` | View the hidden audit trail (`--item "Custom Shirt"`, `--details`) |
| `npm run seed-inventory` | Add the October 8, 2026 delivery |

## How it is built

```
Backend/   Node.js + Express 5 API, PostgreSQL (Neon) + SQLite offline cache, Socket.io
  app.js           the HTTP API (used by server.js and by the tests)
  server.js        start-up: databases, real-time updates, sync, migrations
  routes/          auth, inventory, orders, customers, reports
  services/        sync engine, cloud health watcher, stock rules, Recycle Bin, audit trail, sessions
    domain/        business rules with no HTTP or SQL: permissions, order lifecycle, stock check, payments
  migrations/      numbered, idempotent SQL changes (applied automatically)
  tests/           automated tests + fixture data
Web/       Next.js + TypeScript + Tailwind CSS + shadcn/ui: the screens (port 3000). UI only: no API
           routes, no database, no secrets; every decision comes from the API
  app/             one route per section: /login, /dashboard, /catalog, /orders, /orders/new, /accounts
  scripts/         check-rules.mjs: the CI guard that keeps business rules out of the screens
shared/client-core/  plain-JS helpers with no React (API client, formatting, permissions, receipts),
           used by Web/, Frontend/ and the future mobile app
scripts/   start-shop.ps1 / start-shop.cmd (Windows) and start-shop.sh (macOS / Linux)
Frontend/  React 19 + Vite (inline styles): the MVP/Beta screens, frozen and kept one release as a
           fallback (docs/nextjs-migration-steering.md)
docs/      sprint, audit and migration notes (docs/migration/)
```

- **Source of truth:** Neon PostgreSQL. Writes go to the cloud first. If the cloud is unreachable they are saved to SQLite and synced later, pushing only the changed fields, with conflict detection.
- **Stock:** "Free to use" = on hand − reserved. Orders reserve stock in the same transaction that creates them. Cancelling releases the stock; completing uses it up.
- **Money:** stored as `NUMERIC(10,2)` and compared in whole centavos. Online, a payment locks its order row so two payments at the same moment are checked one after the other. Offline payments are checked against the local copy and are always accepted when they sync; if branches together overpay, the order shows **Overpaid** and the Owner refunds by hand.

## Security and privacy

- Passwords are stored as bcrypt hashes and must have at least 8 characters, a letter and a number.
- Login locks for 15 minutes after 5 wrong passwords. It gives the same answer for an unknown username and a wrong password.
- Sessions last 8 hours. **Logout** ends that device's session on the server (the same login on another device stays signed in). Deactivating an account, changing its role or resetting its password signs it out everywhere at once.
- Roles are always taken from the signed login token and checked on the server.
- All database queries use parameters (no SQL injection). Inputs are validated and errors are shown in plain language.
- Security headers are set, CORS is limited to `CORS_ORIGINS`, and exports are protected against spreadsheet formula injection.
- **Data Privacy Act (RA 10173):** customer names and mobile numbers are only visible to logged-in staff and are used only to process orders. Money exports are limited to the Owner and Admin. Deactivate accounts when staff leave.

## Troubleshooting

| Message | Fix |
|---|---|
| `JWT_SECRET is not set` | Copy `.env.example` to `.env` and set `JWT_SECRET`. |
| `CLOUD SCHEMA IS OUT OF DATE` | Run `npm run migrate`. |
| `Neon closed the idle real-time connection` | Normal: Neon sleeps when idle and the app reconnects by itself. |
| Forgot a password | An Owner/Admin uses **Accounts → Reset password**. If nobody can log in, run `npm run create-admin` with a new username. |
| "Too many wrong passwords" | Wait 15 minutes, or restart the backend. |
| The browser can't reach the API ("Can't reach the shop server") | Check that the API window is still open and that the address you opened (e.g. `http://192.168.1.20:3000`) is listed in `CORS_ORIGINS` in `Backend/.env`. |
| `Something is already using port 5000` / `3000` | The system is probably already open in another window. Close it, or the other program using that port. |
| The screens look out of date after an update | Start once with `-Rebuild` (Windows) or `--rebuild` (macOS / Linux). |
| `Web/ must not receive backend secrets (DATABASE_URL ...)` | The screens must never see the database settings. Remove those variables from the system environment; they belong only in `Backend/.env`. |
