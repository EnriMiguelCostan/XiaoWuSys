# 2026-SE-XiaoMei-Printing-Services

## Tab 1: SIA2 - Background (Submission 1)

| Field | Details |
|---|---|
| **Proponents** | 1. Brost, Patrick William Y.<br>2. Costan, Enri Miguel L.<br>3. Costan, Enzo Gabriel L.<br>4. Morinomoto, Rin |
| **Software Engineering Project Title** | A Web and Mobile-Responsive ERP Application for Order, Inventory, and Financial Management at XiaoMei Printing Services (XiaoWuSys) |
| **Partner Organization** | XiaoMei Printing Services (Agdao, Davao City). Owner: Ana Marie Yu |
| **Adviser** | [X] Candidate adviser confirmed/accepted. Name of Adviser: Sir Antonio Bulao II / Sir Adrian Ablazo |
| **Panelists** | 1. Genesis Emmanuel Gonzales<br>2. Greo Ochoa |

---

### (i) Problem Statement

XiaoMei Printing Services is a garment and print shop in Agdao, Davao City, owned by Ana Marie Yu.

- **What the shop does:**
  - It takes custom jobs: sublimation jerseys for schools and leagues, printed shirts, notebooks, tarpaulins and stickers.
  - It runs from one shop computer, with staff moving between the counter, the printers and the heat presses.
- **How it was run before XiaoWuSys:**
  - Orders arrived through Messenger, walk-ins and phone calls, and were written down on paper or in loose spreadsheets.
  - Stock was counted by eye.
  - Payments and expenses were added up by hand at the end of the month.
- **The problem:** this worked for a few orders a day, but it broke down at peak seasons (school intramurals, league openings). A single order then needs hundreds of blank shirts, a jersey roster of names and numbers, and a downpayment before printing can start.

XiaoWuSys addresses four operational bottlenecks:

1. **Unmanaged inventory capacity and fulfilment.**
   - **Before:**
     - The shop could accept a 300-shirt order without knowing that only 120 blanks were on hand, or that most of the stock was already promised to another order.
     - Shortages were discovered at the printer, after the customer had been promised a date.
     - Consumables (sublimation ink, transfer paper) were never linked to the garments that use them, so they ran out without warning.
   - **Now:**
     - Before an order is saved, the system compares it with the free stock (on hand minus reserved).
     - It halts orders that cannot be filled and offers Delay or Cancel.
     - It reserves blanks for accepted orders and deducts consumables automatically, using per-item usage rates.
2. **Data consistency and connectivity weaknesses across branches.**
   - **Before:**
     - The shop's internet connection is unreliable, and a cloud-only system would stop the counter whenever the connection dropped.
     - Two people editing the same order (for example the Owner changing a price while staff update the deadline offline) could silently overwrite each other.
   - **Now:**
     - Every screen keeps working offline against a local SQLite copy.
     - Offline changes sync to Neon PostgreSQL when the connection returns.
     - Conflicting edits are settled by role rank (Owner > Admin > Production > Staff) and recorded in an append-only audit log.
3. **No way to diagnose waste.**
   - **Before:**
     - Misprints, scorched shirts and defective blanks were thrown away without a record.
     - The Owner could not tell whether losses came from a failing printer, rushed work, or a bad supplier batch, so nothing could be corrected.
   - **Now:**
     - Every loss is logged with a standard reason code and its cost.
     - Each loss is classified automatically as **Machine Failure**, **Human Error** or **Product Defect**.
     - Unusually high losses are flagged with a statistical test.
4. **Manual financial and P&L tracking.**
   - **Before:**
     - Downpayments, balances and expenses were tracked on paper.
     - Nobody could say whether a month was profitable until the Owner reconciled everything by hand.
     - Prices and discounts were set inconsistently.
   - **Now:**
     - Payments are recorded in exact centavos, with a numbered payment acknowledgement.
     - Quotes use volume tiers, and only the Owner can apply discounts, void payments and approve orders.
     - A one-click True-Cost Profit & Loss report covers income, cost of goods, consumables, waste and overheads.

---

### (ii) Sub-systems and Short Description

| # | Sub-system | Short Description |
|---|---|---|
| 1 | **Order & Layout Management** | Records each job order with its customer, production deadline, materials, print details and Google Drive layout link. The link is checked by the server, so only real Drive links are saved. Every order receives a sequential, gapless tracking ID in the format `XM-YYYY-NNNN`, numbered per year in Manila time, and staff can find an order by typing only its number. A bulk jersey roster (sizes, names and numbers) can be imported in one step from a CSV file or pasted from Excel / Google Sheets, and the server accepts every row or none. The Owner calculates the quote from catalog selling prices with automatic volume tiers (5% off from 50 pieces, 10% off from 100) and may apply an Owner-only discount, which always needs a written reason. Edit locks follow the role hierarchy, so a higher role can take over an order being edited. An Owner edit made online prevails over a conflicting offline edit, and the replaced change is kept in the audit log. |
| 2 | **Production & Inventory Engine** | Before an order is saved, a capacity pre-check compares the materials it needs with the free stock. If the stock is short, the order is halted and the user chooses **Delay** (with a new deadline) or **Cancel** (recorded as a lost sale). Approval is Owner-only and needs a quote, at least one material, and a downpayment of at least 50% of the quote that is already synced to the cloud. Approval reserves the order's blank stock. Orders move through `Pending → Approved → Printing → Pressing → Completed`, and every move is written to the append-only `order_status_history` table, which feeds the Status history timeline. When an order reaches Pressing or Completed, the consumables in its bill of materials (`consumable_rates`) are deducted exactly once. Changes are pushed live to every screen through PostgreSQL `pg_notify` and Socket.IO, and orders carry deadline urgency flags (overdue, due within 24 hours, due within 72 hours). |
| 3 | **Diagnostic & Waste Management** | Misprints and catalog losses are logged against an order or directly against a catalog item, using six standard reason codes such as misprint/alignment error, heat-press scorch and supplier defect. If a loss leaves no free stock to replace the ruined pieces, the system warns before production continues. Each loss is classified automatically: **Machine Failure** when two or more Printing/Pressing losses fall within 60 minutes of each other; **Product Defect** for a supplier defect, or when an item's losses are more than 2σ above the other items' average; **Human Error** for a rushed step (Printing to the next step in under 5 minutes) or a human reason code. Each loss stores its financial cost. The dashboard shows waste by cause, unusually high items and recent losses, and the Owner/Admin can export everything to `waste.csv`. |
| 4 | **Financial & System Admin** | Payments are checked in integer centavos, so ₱999.99 never drifts. Each payment records who received it and gets a gapless payment acknowledgement number `AR-YYYY-NNNN` when it reaches the cloud. Overpayments caused by several branches paying offline are detected and shown as **Overpaid** for the Owner to refund. Only the Owner can void a payment; a void is a negative reversing entry with a reason, so the original record is never deleted. The Owner/Admin record monthly overhead expenses. Blank and consumable costs are frozen when they are used, so later price changes never alter past reports, and the Owner-only True-Cost P&L "Magic Button" produces the profit-and-loss statement for any period. Closed orders and customers can be archived (hidden and read-only, never deleted). Accounts use four-tier role-based access control (Owner, Admin, Production, Staff), with lockout after failed logins, per-device logout and instant sign-out when an account changes. |

---

### (iii) Technical Output & Proposed Framework/Platform/Technology

**Technical Output:**

- [X] Web Application (mobile-responsive; works on the shop computer, tablets and phones)
- [X] Locally-deployed system (shop server + LAN tablet access)
- [ ] Mobile Application (native)
- [ ] Desktop Application

**Framework / Platform / Technology:**

| Layer | Technology |
|---|---|
| Front end (screens) | **Next.js 16.4.6** (App Router) with **React 19.3.0** and **TypeScript 5**, styled with **Tailwind CSS 4.3.3**, using **Radix UI** / **shadcn/ui** components and **lucide-react** icons. It is UI only: no API routes, no database access and no secrets. |
| Shared client library | **`@xiaowu/client-core`** (plain JavaScript in `shared/client-core/`): the API client, runtime API-address resolution, formatting (pesos, dates, `formatMobile`), CSV parsing, permissions lookup and receipt text. It is shared by the Web app and the future mobile app. |
| Back end (API) | **Node.js 22+** with **Express 5.2.1**, **jsonwebtoken 9** (8-hour login tokens), **bcrypt 6** (password hashing) and **Socket.IO 4.8** (live stock and order updates). |
| Cloud database (source of truth) | **Neon PostgreSQL**, through **`pg` 8.23** with `LISTEN/NOTIFY` for cross-branch live updates, and 14 numbered, idempotent migrations (`001`–`014`). |
| Offline database | **SQLite3 6** (`local_cache.db`): an offline fallback that is synced to the cloud when the connection returns. |
| Deployment | Shop computer plus LAN tablets (`0.0.0.0` binding, `scripts/start-shop.*`); **Docker Compose** (`Backend/Dockerfile`, `Web/Dockerfile`, `docker-compose.yml`); **AWS Amplify Hosting** for the Web app (`amplify.yml`). |
| Quality gates | **GitHub Actions CI** (`.github/workflows/ci.yml`). It runs the backend tests against a real PostgreSQL 16 service, the client-core tests, and in `Web/`: `check-rules.mjs` (keeps business rules out of the screens; 33 self-tests), `check-contrast.mjs` (WCAG 2.1 AA colour contrast), ESLint, TypeScript and `next build`. |

---

### (iv) Data Sources

- [X] **Not Applicable.** The system does not depend on an external dataset. All data (catalog, customers, orders, payments, losses, expenses) is entered by shop staff during daily operations.

*Note:* The starting catalog was seeded from the shop's real supplier delivery of **October 8, 2026** (`npm run seed-inventory`, `Backend/scripts/seedInventory.js`). It includes Valiant Record Book and Columnar notebooks, Quaff Sublimation Transfer Paper, Deli A4 Paper, B&E Oslo Drawing Paper, Sales Invoice Receipts and Custom Shirts, with their actual quantities and unit costs.

---

### (v) Did you start developing your solution already?

- [X] **Yes**
- [ ] No

**Summary of completed work:**

- **All four sub-systems are implemented end to end**, from database to API to screens, and run in the shop's daily workflow:
  - **Order & Layout Management:** tracking IDs, roster import, Drive-link validation, volume quotes, Owner discounts, edit locks and conflict override.
  - **Production & Inventory Engine:** capacity halt with Delay/Cancel, Owner approval gate with downpayment, stock reservation, the Pressing stage, status history, consumable deduction, live updates and deadline flags.
  - **Diagnostic & Waste Management:** reason codes, replacement-stock warnings, automatic cause triangulation, statistical anomalies, waste costs and `waste.csv`.
  - **Financial & System Admin:** centavo-checked payments, `AR-YYYY-NNNN` acknowledgements, overpayment detection, Owner voids, overheads, historical COGS, the True-Cost P&L, archiving and four-role account management with per-device logout.
- **Database:** 14 migrations, applied automatically at start-up and safe to run more than once:
  - `001` automatic `last_modified`; `002` legacy Neon alignment; `003` live inventory notifications; `004` Recycle Bin, inventory audit trail and stock reservation;
  - `005` job-order approval; `006` account activation, units and suppliers; `007` `XM-YYYY-NNNN` tracking numbers and revoked sessions; `008` payments and `AR-YYYY-NNNN` receipts;
  - `009` conflict override and audit log; `010` the Pressing status and status history; `011` consumables, quotes and discounts; `012` waste diagnostics, voids and overheads;
  - `013` archiving and historical cost of goods; `014` account removal.
- **Front end:** the screens were migrated from the Vite MVP to Next.js (milestones M0–M5). The old `Frontend/` is frozen and kept for one release as a fallback.
- **Testing:**
  - **242 automated back-end tests:** 182 run on the offline server; 60 run against a real PostgreSQL database in CI.
  - **13 `client-core` tests** and **33 rules-guard self-tests.**
  - **Load test:** 155 simultaneous requests on the offline server, plus 120+ on real PostgreSQL.
- **Usability and accessibility:** a full HCI pass to WCAG 2.1 AA, documented in `docs/hci-design-audit.md`:
  - contrast checked by script in CI;
  - 40px touch targets on touch screens;
  - feedback that shows busy, pending-sync, success and blocked states;
  - error messages beside the field, and "Go to …" links that lead to the fix.
- **Deployment:** start-up scripts for the shop computer, Docker Compose, and AWS Amplify configuration.

---

### (vi) Major Issues/Concerns & How They Were Resolved

| # | Issue / Concern | How it was resolved |
|---|---|---|
| a | **Offline SQLite sync vs. an online Owner override.** A staff member edits an order offline while the Owner changes the same order online; when the branch reconnects, one change would silently overwrite the other. | Each order records `last_edited_by` and `last_edited_role` (migration 009). The sync engine (`services/sync.js`) pushes only the changed fields, and only if the cloud row still has the version the device last saw (optimistic lock). On a mismatch, the change from the higher rank is kept (`ROLE_RANK`: Owner 4 > Admin 3 > Production 2 > Staff 1), and the replaced values are written to the append-only `audit_log` with the action `conflict_override`. The person whose change was replaced is told at once through the Socket.IO event `order_overridden`. Equal ranks, and every other table, stay flagged until an Owner or Admin picks a side (`POST /api/sync/conflicts/:table/:id/resolve`). |
| b | **SQLite lock contention under 150+ simultaneous offline writes.** In the load test, every request opened its own SQLite connection and raced for the single write lock. Requests that waited past the 5-second busy timeout failed with `LOCAL_CACHE_ERROR`, and the burst took **145 s**. | `withLocalTransaction` (`services/records.js`) now queues this server's transactions per database file, one after another. The same burst finishes in **about 1.3 s** with no failures. This is covered by `tests/load-stress.test.js` (155 simultaneous requests) and `tests/m6-part4.pg.test.js` (a 60-row offline burst pushed exactly once, even with 15 simultaneous "Sync now" presses). |
| c | **Using the system on several devices in the shop.** Tablets on the shop Wi-Fi could not reach a server bound to `localhost`, and a fixed API address would break whenever the shop computer's IP changed. | The API listens on `0.0.0.0` (`HOST`, default in `server.js`), and the screens work out the API address at run time from the address they were opened with (`@xiaowu/client-core/config`). A tablet that opens `http://<shop-computer-IP>:3000` therefore calls `http://<shop-computer-IP>:5000` automatically. `scripts/start-shop.*` starts both servers. For other hosting, `docker-compose.yml` runs the API and the screens as two containers, with the SQLite cache on a persistent volume, and `amplify.yml` deploys the screens to AWS Amplify with a fixed https API address (`NEXT_PUBLIC_API_URL`). |
