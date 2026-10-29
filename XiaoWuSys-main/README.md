# XiaoWuSys

Inventory and order management for **XiaoMei Printshop** (Agdao, Davao City). It replaces the stock whiteboard, the order notes kept in Messenger, and the Excel / Google Sheets logs. Capstone project, Software Engineering 2.

## What it does

| Area | Features |
|---|---|
| **Catalog** | Sortable stock table with live updates. Each item has a unit (pcs, pack, ream…), a supplier and a low-stock alert. **Add / Subtract Stock** with a reason; lost or damaged stock is recorded with its cost. Duplicate names are blocked, ignoring case and spaces. Edit items, delete them to the **Recycle Bin** (restorable), **import from Excel** (CSV) and **export to Excel**. |
| **Orders** | Create an order for a saved or new customer (11-digit mobile number). Every order gets a sequential **order number** like `XM-2026-0123` that restarts each January (an order saved offline gets its number when it syncs); search by it in the Orders tab. Stock is checked and **reserved** automatically; a halted order can be delayed or cancelled. The order detail shows materials, print details (size / name / number), the Google Drive design link and payments with the balance. **Only the Owner** sets or changes the quote and cancels an order. Status runs Pending → Approved (Owner only, needs a 50% downpayment) → Printing → Completed. Approve and Resume are greyed out, with the reason, while the free stock does not cover the order. **Copy for Messenger** and **Print job order** buttons. |
| **Dashboard** | A **yellow low-stock warning** pinned at the top while any material is at or below its alert level (it updates live and disappears after restocking). Overdue orders, orders due this week, unpaid balances, payments per month, most-used materials, and a **restock list** with suggested quantities (copyable). Inventory, order and payment exports. |
| **Accounts** | The Owner / Admin create accounts, change roles, reset forgotten passwords and deactivate staff who left. Everyone can change their own password. |
| **Offline** | If the internet drops, the system keeps working on a local copy and syncs when the connection returns. Accounts that have logged in on that computer can log in offline. |
| **Traceability** | Every catalog change is written to a hidden, append-only audit trail (`npm run audit-log`). |

### Roles

| Role | Can do |
|---|---|
| Owner | Everything, including the money decisions only the Owner makes: setting or changing quotes, cancelling (voiding) orders and approving job orders; manages Owner accounts |
| Admin | Everything except the Owner's money decisions (quotes, cancelling orders, approving); manages non-Owner accounts |
| Production | Catalog, stock and orders |
| Staff | View the catalog, orders and dashboard |

## Quick start

You need **Node.js 22 or newer**.

### Option A: demo mode (no Neon account needed)

```bash
cd Backend
npm install
npm run demo          # creates demo_cache.db with sample data and starts the API
```

In a second terminal:

```bash
cd Frontend
npm install
npm run dev           # open the address it prints (usually http://localhost:5173)
```

Log in as `owner`, `admin`, `production` or `staff`. The password for all of them is **`XiaoMei2026`**.

Demo mode runs fully offline, on its own database file that is never synced. Actions that must reach every branch (approving, status changes, permanent delete, account changes) show the "needs the internet" message.

### Option B: with the cloud database (Neon PostgreSQL)

1. Create a free project at [neon.tech](https://neon.tech) and run `Backend/schema.sql` in its SQL Editor.
2. `cd Backend`, then copy `.env.example` to `.env` and fill in `DATABASE_URL`, `PG_LISTEN_URL` and a long random `JWT_SECRET`.
3. Run `npm install`.
4. Create the first account:
   ```bash
   ADMIN_USERNAME=owner ADMIN_PASSWORD='YourPassw0rd' ADMIN_ROLE=Owner npm run create-admin
   ```
   On Windows PowerShell, set the variables first:
   ```powershell
   $env:ADMIN_USERNAME="owner"; $env:ADMIN_PASSWORD="YourPassw0rd"; $env:ADMIN_ROLE="Owner"; npm run create-admin
   ```
5. `npm start`. Pending database migrations are applied automatically on start.
6. Optional: run `npm run seed-inventory` to add the October 8, 2026 delivery.
7. Start the frontend as in Option A. If the API isn't on `localhost:5000`, copy `Frontend/.env.example` to `Frontend/.env` and set `VITE_API_URL`.

## Tests

```bash
cd Backend
npm test
```

There are 78 automated tests in `Backend/tests/`. They start the real API on a throw-away SQLite database filled with the shop's own data (`tests/fixtures/data.js`), with the cloud switched off, and call it over HTTP like the browser does.

`tests/migrations.pg.test.js` adds 8 more that apply `schema.sql` and every migration to a real, throw-away PostgreSQL and check order numbering. They run when `TEST_DATABASE_URL` is set, which **wipes that database**, so it must be on `localhost` or have "test" in its name (never Neon):

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/xiaowusys_test npm test
```

**CI:** every push runs the backend tests (with a PostgreSQL 16 service for the migration tests) and the frontend lint and build on GitHub Actions (`.github/workflows/ci.yml`).

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
- payments and balances;
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
  services/        sync engine, stock rules, Recycle Bin, audit trail, sessions
    domain/        business rules with no HTTP or SQL: permissions, order lifecycle, stock check
  migrations/      numbered, idempotent SQL changes (applied automatically)
  tests/           automated tests + fixture data
Frontend/  React 19 + Vite (inline styles): the MVP/Beta client. It moves to Next.js + Tailwind CSS and
           a mobile app at the end of the project (docs/sprint-12-steering.md §3)
  src/lib/         plain-JS helpers with no React (reused by the future clients)
docs/      sprint and audit notes
```

- **Source of truth:** Neon PostgreSQL. Writes go to the cloud first. If the cloud is unreachable they are saved to SQLite and synced later, pushing only the changed fields, with conflict detection.
- **Stock:** "Free to use" = on hand − reserved. Orders reserve stock in the same transaction that creates them. Cancelling releases the stock; completing uses it up.
- **Money:** stored as `NUMERIC(10,2)` and compared in whole centavos.

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
| The browser can't reach the API | Check that the backend is running, `VITE_API_URL` in `Frontend/.env`, and `CORS_ORIGINS` in `Backend/.env`. |
