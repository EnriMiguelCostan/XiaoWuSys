# XiaoWuSys: Next.js + Tailwind + shadcn/ui migration steering

> Read this together with `master-context-steering.md` (ground rules, Batch 1 + 2 mechanics) before writing any Next.js code.
> Status: **APPROVED 2026-11-12** (N1–N9 and §8 answered). Batch M0 in progress. Nothing here changes the backend contract unless it says so.
> Baseline: `main` at **805a619** (PR #16 merged). Migrations 001–008 applied. Next backend migration is 009.

---

## 0. Before Batch M0: refresh the code snapshot

Done: `repomix-output.xml` was regenerated from `main@805a619` on 2026-11-12. Do the per-screen audits in §3.4 against a fresh snapshot of `main` at the start of each M-batch.

---

## 1. Decisions (all approved 2026-11-12)

| # | Decision | Approved |
|---|---|---|
| N1 | Where the Next.js app runs | On the **same shop computer as Express**, as a second local process. Never hosted only in the cloud: the app must open when the internet is down. |
| N2 | What the Next.js server is allowed to do | **Serve UI only.** No Route Handlers under `/api`, no Server Actions, no `middleware.ts` auth decisions, no data fetching in Server Components, no `DATABASE_URL`. Express stays the only API and the only authority. |
| N3 | How the browser talks to the backend | **Directly to Express**, exactly as today (Bearer token in `Authorization`, Socket.io with `auth: { token }`). Add the Next.js origin to `CORS_ORIGINS`/`DEFAULT_ORIGINS`. No Next.js rewrites/proxy in v1 (WebSocket upgrades through rewrites are unreliable). |
| N4 | Auth storage | Keep the current JWT in `localStorage` (`xiaomei_token`, `xiaomei_user`) so logout, device sessions and offline login behave exactly as they do now. Moving to an httpOnly cookie is a backend change (CSRF, socket auth) and is **out of scope**. |
| N5 | Language | **TypeScript in `Web/`** (shadcn default; lets us type the decision payloads). The shared client core stays plain JS with JSDoc so React Native can use it as-is. |
| N6 | Shared non-UI code | Move `Frontend/src/lib/*` and the non-DOM parts of `api.js` into `shared/client-core/`, consumed by both apps through a `file:` dependency. |
| N7 | Old Vite app during migration | **Frozen**: bug fixes only, no new features. Deleted one release after cutover. |
| N8 | Dark mode | Build the token layer dark-ready in M0, but **ship dark mode as its own small PB after parity** (it was postponed until this move; don't mix it into the port). |
| N9 | Batch 3 / PB 15 UI | Built **only in Next.js**, after the screens they extend are ported (see §5). |

---

## 2. Architecture

### 2.1 Runtime picture (per branch)

```
Shop computer (each branch)
├── Express API  :5000   Backend/  ── Neon PostgreSQL (source of truth, cloud-first writes)
│                                    └─ SQLite local_cache.db (offline fallback, sync)
│   ├── REST  /api/*      (decisions: capabilities, allowed_actions, totals, sync_status…)
│   └── Socket.io         (inventory_updated, sync_status, lock events; later order_updated)
│
└── Next.js UI   :3000   Web/   (`next start`, standalone build)
    └── serves HTML/JS/CSS only; holds no secrets, no DB access, no business rules

Browser ──HTTP(S)──> Next.js :3000  (pages, assets)
Browser ──fetch───> Express :5000/api   (Bearer JWT)
Browser ──WS──────> Express :5000       (Socket.io, JWT auth)
```

- **Neon is invisible to `Web/`.** The Next.js process never gets `DATABASE_URL`, `PG_LISTEN_URL` or `JWT_SECRET`. CI fails if `Web/` imports `pg`, `sqlite3`, `jsonwebtoken`, or reads those env names (§6 guard).
- **Offline:** because both processes run on the shop computer, the UI loads and Express falls back to SQLite exactly as today. No CDN assets: fonts self-hosted in `Web/public/fonts`, icons from `lucide-react` (already approved).
- **API base at runtime, not build time.** `NEXT_PUBLIC_*` values are frozen into the build, which breaks "one build, many branches". `shared/client-core/config.js` resolves the API base as: `NEXT_PUBLIC_API_URL` if set, else `${location.protocol}//${location.hostname}:5000/api`. Socket URL derived the same way.
- **LAN tablets (Q4):** Express and Next.js both listen on `0.0.0.0` (`HOST` in `Backend/.env`, `-H 0.0.0.0` in the `Web/` scripts). Tablets open `http://<shop-computer-ip>:3000`; the UI then calls `http://<shop-computer-ip>:5000/api` by itself. Each such origin must be listed in `CORS_ORIGINS`; the backend prints the exact entries to add when it starts. Give the shop computer a fixed address on the router (DHCP reservation), or the list goes stale.
- **Backend changes in M0 (the only ones):** `http://localhost:3000` and `http://127.0.0.1:3000` added to `DEFAULT_ORIGINS` and `.env.example` (shops that already have a `Backend/.env` must add them by hand, because `CORS_ORIGINS` replaces the defaults); `HOST` setting (default `0.0.0.0`) with start-up LAN hints; `tests/cors-origins.test.js`. Nothing else in `Backend/` changes during the port.

### 2.2 Repository layout

```
XiaoWuSys-main/
├── Backend/                       unchanged (except the CORS default in M0)
├── Frontend/                      Vite MVP, frozen; switches its lib imports to client-core in M0
├── shared/
│   └── client-core/               plain JS, no React, no DOM  → Web, Frontend, future React Native
│       ├── package.json           name: "@xiaowu/client-core"
│       ├── api.js                 createApi, errorText, FRIENDLY_ERRORS (from Frontend/src/api.js)
│       ├── format.js              peso, formatDateTime, todayInManila, MOBILE_PATTERN
│       ├── config.js              runtime API/socket base resolution
│       ├── permissions.js         can(user, cap), orderActions(detail)   (moved from src/lib)
│       ├── orders.js              NUMBER_AFTER_SYNC, display helpers      (moved from src/lib)
│       ├── connection.js          deriveConnectionState, connectionText, pendingText,
│       │                          syncDisabledReason, syncResultMessage   (moved from src/lib)
│       └── receipt.js             receiptLines, receiptHtml, receiptText, escapeHtml
└── Web/                           Next.js App Router + Tailwind + shadcn/ui
    ├── app/
    │   ├── layout.tsx             <html>, self-hosted font, globals.css
    │   ├── login/page.tsx
    │   └── (app)/                 everything behind login
    │       ├── layout.tsx         'use client' shell: SessionProvider, SocketProvider,
    │       │                      ConnectionBar, nav, ChangePasswordDialog
    │       ├── catalog/page.tsx
    │       ├── orders/page.tsx    list; detail opens as a Sheet via ?order=<order_id>
    │       ├── orders/new/page.tsx  Create Order + capacity halt (today inside App.jsx)
    │       ├── dashboard/page.tsx
    │       └── accounts/page.tsx
    ├── components/
    │   ├── ui/                    shadcn-generated primitives (owned, editable, no logic)
    │   ├── feedback/              ResultDialog, ConfirmDialog (built on shadcn Dialog/AlertDialog)
    │   ├── connection/            ConnectionBar, SyncNowButton
    │   ├── catalog/  orders/  payments/  dashboard/  accounts/
    ├── hooks/                     useApi, useSession, useSocketEvent, useFallbackPolling
    ├── lib/
    │   ├── ui-tokens.ts           ONE place mapping server states → classes/labels/icons
    │   └── print.ts               window.open + print() for receipts and job orders
    └── public/fonts/
```

`shared/client-core` is referenced as `"@xiaowu/client-core": "file:../shared/client-core"` from both `Frontend/package.json` and `Web/package.json`, so `npm ci` keeps working per app with no root workspace. `Web/next.config` lists it in `transpilePackages`.

### 2.3 Data flow inside `Web/`

- Every page under `(app)/` is a **client** tree. Data comes from Express through `useApi()` (a thin hook over `createApi`), which keeps today's contract: never throws, `{ ok, status, data }`, `status 0` = server unreachable, `401` → session ended.
- **One socket per signed-in tab**, owned by `SocketProvider` (today it lives in `App.jsx`). Screens subscribe with `useSocketEvent('inventory_updated', …)`. Socket closes on logout and when the server revokes the session (`onSessionRevoked`).
- **Polling rule unchanged:** `useFallbackPolling(fn, 30_000)` runs only while `SocketProvider` reports `disconnected`. No `refetchOnWindowFocus`-style behaviour. No TanStack Query / SWR during the port (their background refetching would break this rule silently); revisit after parity.
- Auth gate is client-side and **cosmetic only**: no token → redirect to `/login`. Every real check is the server's 401/403.

---

## 3. Porting strategy

### 3.1 The rule, restated for React components

> A component may **render** a decision, **format** a value and **collect** input. It may never **decide**.

| Allowed in `Web/` | Not allowed in `Web/` (must come from the API) |
|---|---|
| Show/hide a button from `allowed_actions.*` or `can(user, cap)` | `if (user.role === 'Owner')` or any role-string comparison |
| `max` / placeholder from `allowed_actions.max_payment` | Computing remaining balance, 50% downpayment, `ceil(quote/2)` |
| Rendering `payment_status`, `stock_status`, `sync_status`, `downpayment.met` | Deriving status from numbers (`paid >= quote`, `available - reserved`) |
| Showing `payment_blocked_reason`, `syncDisabledReason()` text | Writing your own "why it's disabled" rules |
| `peso()`, `formatDateTime()` | Money arithmetic in floats or centavos |
| Required-field / "is a number" checks for UX | Duplicating server limits (99,999,999.99, quote freeze, status transitions) |
| Displaying the server's `message` via `errorText()` | Parsing error text or inventing new error meanings |

Specific consequences:

- **Owner-only actions** (approve, set quote, cancel/void, future discount) are shown only when `allowed_actions`/`capabilities` say so, and the server still answers `403 QUOTE_OWNER_ONLY` / `VOID_OWNER_ONLY` / `FORBIDDEN` if anything slips through. The Admin must see the same hidden buttons the Owner-only rules imply; test with the Admin account specifically.
- **Forms:** if you use `react-hook-form`, its schema may only express *format* (required, number, 11-digit mobile pattern from `MOBILE_PATTERN`). Never encode a business limit in a zod schema. A `400 VALIDATION_FAILED` from the server is the source of truth and is shown next to the form.
- **Numbers in requests stay JSON numbers** (the server rejects `"5"`). Inputs convert with `Number()` before sending, as today.
- **If a screen needs a rule the API doesn't return yet, stop**: add the field on the server (domain function + test) in a backend PR first, then port the screen. Never "temporarily" compute it in the client.

### 3.2 Visual states: one token file

`Web/lib/ui-tokens.ts` replaces `CONNECTION_STYLE[state]`, `PAYMENT_STATUS_META` and the per-file style objects:

```ts
export const CONNECTION = {
  online:        { label: 'Online',                               tone: 'success', icon: Wifi },
  offline_local: { label: 'Offline: saving on this computer',     tone: 'warning', icon: HardDrive },
  server_down:   { label: "Can't reach the shop server",         tone: 'danger',  icon: ServerCrash },
  checking:      { label: 'Checking connection…',                 tone: 'muted',   icon: Loader },
} as const;
// PAYMENT_STATUS (Unpaid | Partial | Fully Paid | Overpaid), ORDER_STATUS, STOCK_STATUS, SYNC_STATUS …
```

- Labels for connection states come from `connectionText()` in client-core where they already exist; the token file only adds tone and icon.
- `tone` maps to semantic CSS variables (`--success`, `--warning`, `--danger`, `--muted`) declared in `globals.css` alongside shadcn's variables. Dark mode later = one extra variable block, no component changes.
- Components never hard-code colours for states.

### 3.3 MVP component → Next.js mapping

| Vite MVP | Next.js / shadcn target | Notes |
|---|---|---|
| `App.jsx` login form | `app/login/page.tsx` with `Card`, `Input`, `Label`, `Button` | Same lockout / error texts from server. |
| `App.jsx` header, tabs, sticky status bar | `(app)/layout.tsx`: nav + `ConnectionBar` (`aria-live="polite"`), pending badge, conflict count (Owner/Admin via `can`), `SyncNowButton` with `Tooltip` for the disabled reason | Tabs become routes so pages are linkable. |
| `App.jsx` socket + inventory snapshot | `SocketProvider` + `useInventorySnapshot()` | Highlight of `recentlyChanged` rows kept (2.5 s). |
| `App.jsx` Create Order + capacity alert | `orders/new/page.tsx`, customer picker = `Command`/`Combobox`, capacity halt = `AlertDialog` (Delay / Cancel choices) | Capacity "Cancel" stays open to all roles (nothing reserved yet). |
| `InventoryCatalog.jsx` | `catalog/page.tsx`: `Table`, `DropdownMenu` row actions, `Dialog` for add/edit/adjust/loss, `Badge` for stock status | Sorting/filters keep their current server/client split; don't add client-side rules. |
| `InventoryImport.jsx` | `Dialog` + preview `Table`; `parseCsv` moves to client-core | |
| `RecycleBin.jsx` | `Sheet` opened from Catalog | Purge / empty confirmations via `AlertDialog`. |
| `OrdersPage.jsx` list | `orders/page.tsx`: server-sorted, paginated `Table` (`DEFAULT_SORT` preserved), filters with `Select` | `tracking_no` search unchanged. "New order" label for unsynced. |
| `OrdersPage.jsx` detail pop-up | `OrderDetailSheet` opened by `?order=<order_id>` | Buttons only from `orderActions(detail)`. Overpaid red warning from `payment_status`. |
| Payment form | `PaymentForm` inside the sheet | `max` + placeholder from `allowed_actions.max_payment`, **Pay full balance** button, `PAYMENT_EXCEEDS_BALANCE` shows server message, warnings in the success `ResultDialog`. |
| Receipt / job order print | `lib/print.ts` + `receiptHtml()` from client-core | Same title, footer, provisional text. Never the word "BIR". |
| `Dashboard.jsx` | `dashboard/page.tsx`: `Card` KPIs, Overpaid panel (only rendered when the server returns rows), CSV export buttons | `downloadFile` stays in `Web/` (DOM). |
| `UsersPage.jsx` + `ChangePasswordDialog` | `accounts/page.tsx` + dialog in shell | Assignable roles come from `assignable_roles` in the response. |
| `Dialogs.jsx` `ResultDialog`, `ConfirmDialog` | `components/feedback/*` on shadcn `Dialog` / `AlertDialog` | "Every result ends in a ResultDialog" rule kept; no silent toasts for results. |

### 3.4 Per-screen porting audit (do this before porting each screen)

For each MVP file, list every expression in a table with one of three labels:

1. **Presentation** (layout, state for open/closed, highlight timers) → port freely.
2. **Formatting** (`peso`, dates, labels) → must call client-core.
3. **Rule** (anything deciding money, stock, status, permission) → must already be an API field. If not: backend PR first.

Commit the audit as `docs/migration/<screen>-audit.md` in the same PR. Reviewers check category 3 is empty in `Web/`.

### 3.5 Wording and UX rules carried over unchanged

Plain English for printshop staff; no field names or raw UUIDs (use `XM-2026-0123`, "New order", "Given after sync"); no time-zone codes; Manila wall-clock display; never "BIR". Form controls readable on light theme (shadcn `Input` defaults satisfy the old `colorScheme: 'light'` rule while the theme stays light).

---

## 4. Execution plan (UI migration batches)

One branch and one PR per batch (`feat/next-m0-scaffold`, …), 1 approving review, opened via `gh api`. **No backend behaviour changes** inside M-batches except the M0 CORS default. Each PR description lists what was and wasn't checked by hand.

### M0 — Scaffold and guardrails (no screens) — IN PROGRESS
- Create `Web/` (App Router, TypeScript, Tailwind, `shadcn init`, `lucide-react`); pin exact Next.js/Tailwind/shadcn versions in the PR.
- Create `shared/client-core/`; move `Frontend/src/lib/*` and non-DOM parts of `api.js` there; switch `Frontend/` imports to it. Frontend lint + build must stay green (proves the move is behaviour-neutral).
- `globals.css` tokens incl. semantic state colours; `lib/ui-tokens.ts` skeleton; self-hosted font.
- Backend: Next origins in `DEFAULT_ORIGINS` + CORS test.
- CI: new `web` job → client-core tests, rules-guard tests, rules guard (§6), `lint`, `typecheck`, `build`.
- `next.config.ts` refuses to build or start if `DATABASE_URL`, `PG_LISTEN_URL`, `JWT_SECRET` or `TEST_DATABASE_URL` are in its environment.
- No remote fonts or CDN files (system font stack); the guard enforces it.
- Backend: `HOST` (default `0.0.0.0`) + LAN start-up hints (Q4).
- Update `master-context-steering.md` rule 5: inline-style rule now applies to `Frontend/` only; `Web/` uses Tailwind + shadcn.

### M1 — Shell, session, connection
- Login, logout (device-only), change password, client auth gate, 401 → back to login.
- `SocketProvider`, `useSocketEvent`, `useFallbackPolling`.
- `ConnectionBar`, pending badge, conflict count, **Sync now** with every outcome in a `ResultDialog` (`syncResultMessage`), `/api/sync/status` fetched on the same triggers as today.
- Empty placeholder pages for the four sections.

### M2 — Catalog
- Catalog table, live updates + highlight, add/edit/adjust stock, loss, low-stock pin, CSV import/export, Recycle Bin.

### M3 — Orders and payments
- Orders list (server sort, paging, filters, number search), Create Order + capacity halt, Order detail sheet, approve, status changes, details edit, payments, receipts, job order print, Copy for Messenger.
- Highest-risk batch: Owner-only and payment caps. Manual check with **all four roles**, plus offline (`npm run demo`) for provisional receipts.

### M4 — Dashboard and Accounts
- Dashboard KPIs, Overpaid panel (finance roles only, as returned), exports; Accounts page.

### M5 — Parity sign-off and cutover
- Run the full parity checklist (every MVP feature in the README table + §6 manual checks of `master-context-steering.md`) side by side on both UIs.
- Start-up scripts for the shop computer start Express + Next.js; `README` quick start updated.
- Vite `Frontend/` kept one release as fallback, then removed in a follow-up PR.

### M6+ — New features (Next.js only)
- Batch 3 UI (PB 14, PB 5), then dark mode PB, then PB 15 UI. See §5.

### Definition of done for every M-batch
- `web` CI job green; Frontend still green until removed.
- Audit file for each ported screen with no "Rule" rows living in `Web/`.
- **Decision-flip check** (the UI equivalent of the mutation check): temporarily make the backend return the opposite decision (e.g. `allowed_actions.record_payment = false`, `max_payment` smaller, `capabilities` without `approve_order`) and confirm the UI follows it with no other change.
- Keyboard and screen-reader pass on new dialogs (Radix focus trap, labelled inputs, `aria-live` on status).

---

## 5. Remaining backlog: PB 14, PB 5, PB 15

**Recommendation: yes, build their UI directly in Next.js, but don't wait for full migration to start their backend work.** Split each PB into a backend half and a UI half.

| Item | Backend half (can run in parallel with M1–M3) | UI half (Next.js only) | UI depends on |
|---|---|---|---|
| **PB 5** Edit locks + conflicts | Migration 009: lock override with `audit_log`, `POST /api/sync/conflicts/:table/:id/resolve` with rank rules, tests. **Can run in parallel with M1–M4** (the Vite app never calls these). | "Being edited by …" banner, Owner override `AlertDialog`, Conflicts page for Owner/Admin | M1 (socket, connection bar), M3 (order detail) |
| **PB 14** Pressing step | Migration 010: `Pressing` status, `order_status_history`, `order_updated` socket events, `allowedActions` updated, tests incl. real-PG. **Only after cutover (M5)** (Q2). Pressing is **optional**: Printing → Pressing → Completed and Printing → Completed are both allowed (Q3: apparel is pressed, tarpaulins and stickers are not). | Status stepper with Pressing shown as optional, history timeline, live list updates via `useSocketEvent('order_updated')`. Next-status buttons come only from `allowed_actions.statuses`. | M1 (socket), M3 (orders), M5 cutover |
| **PB 15** Consumables + inventory units refactor | Migration 011, units refactor across ENTITIES / SYNC_TABLES / localSchema / schemaCheck | Catalog unit display/editing, consumables screens | M2 (catalog), and Batch 3 merged |

Reasoning:
- Building Batch 3 screens in the frozen Vite app means writing them twice; the edit-lock and conflict screens are exactly the kind of stateful UI that benefits from shadcn's accessible dialogs.
- PB 5's backend half doesn't touch `Frontend/` or `Web/`, so it runs during the port. **Change from sprint-12-steering.md:** Batch 3 no longer ships as one migration. PB 5 is 009 and PB 14 is 010, because PB 14 waits for cutover (Q2). Update sprint-12-steering.md §2 when Batch 3 starts.
- **Don't fold PB 14/PB 5 into M3.** Port to parity first, then add features; otherwise reviewers can't tell a porting regression from a new behaviour.
- Decided (Q2): PB 14's backend ships only after cutover, so the live Vite app never sees `Pressing`. "Cutover" means M5, when Next.js becomes the UI every branch uses. Merging M3 alone isn't enough, because the Vite app stays live until M5.
- Decided (Q3): Pressing can be skipped. `orderLifecycle.allowedActions` returns both `Pressing` and `Completed` as next statuses from Printing. The server keeps the rule; the stepper just shows what it is given.

Order: M0 → M1 → (M2 ∥ PB 5 backend) → M3 → M4 → M5 cutover → PB 14 backend → PB 5 + PB 14 UI → dark mode → PB 15.

---

## 6. Guardrails in CI (`web` job)

`Web/scripts/check-rules.mjs` (tests: `scripts/check-rules.test.mjs`; `node scripts/check-rules.mjs --list` prints the rules) fails CI when `Web/` or `shared/client-core/`:

| Rule id | Catches |
|---|---|
| `no-api-routes` | `app/**/route.ts`, `pages/`, `middleware.ts`, `proxy.ts` (Next 16 name) |
| `no-server-actions` | `'use server'` |
| `no-backend-imports` | `pg`, `postgres`, `sqlite3`, `node:sqlite`, `@neondatabase/*`, `jsonwebtoken`, `jose`, `jwt-decode`, `bcrypt`, `express`, `next/server` |
| `no-backend-env` | `DATABASE_URL`, `PG_LISTEN_URL`, `JWT_SECRET`, `TEST_DATABASE_URL` (except `next.config.ts`, which refuses them) |
| `no-token-decoding` | `atob(`, base64 decoding of the token |
| `no-role-checks` | `role ===`/`!==`, quoted `'Owner'`/`'Admin'`/`'Production'`/`'Staff'` |
| `no-rule-math` | arithmetic or comparisons on money/stock fields, `/ 2`, `* 0.5`, `* 100`, `Math.ceil/floor/round` (not in `components/ui/`) |
| `no-remote-assets` | `next/font/google`, Google Fonts URLs, CDNs (code and CSS) |
| `polling-only-in-fallback-hook` | `setInterval` outside `hooks/use-fallback-polling.ts` |
| `one-socket` | `socket.io-client` outside `components/providers/socket-provider.tsx` |
| `token-storage-in-session-only` | `localStorage`/`sessionStorage` outside `lib/session.ts` |
| `client-core-stays-plain` | React/Next imports, `document.`, `navigator.`, `window.` (except `window.location`) in client-core |

Comments are ignored. A reviewed exception is `// rules-guard: allow <rule-id> <reason of three words or more>` on the line or the line above; every one is printed in the CI log. Today there is one: the print button inside the receipt HTML string.

It's a tripwire, not proof; the audit files and review remain the real check.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Two processes on the shop computer | One start-up script; `/api/status` health check before opening the browser; document in README. |
| Build-time env baked into bundle | Runtime API base resolution (§2.1). |
| Silent drift between Vite and Next during the port | Vite frozen (N7); parity checklist in M5. |
| Client starts "helping" with rules | §3.1 table, §3.4 audits, §6 guard, decision-flip check. |
| Socket duplication (one per screen) | Single `SocketProvider`; lint for `io(` outside it. |
| shadcn components drift from accessibility defaults when restyled | Change tokens, not Radix structure; keyboard pass in DoD. |
| Accelerated timeline vs. Batch 3 | Backend halves run in parallel (§5); UI halves wait for their screen. |

---

## 8. Answers (2026-11-12)

1. N1–N9: approved as written.
2. PB 14 backend: after cutover (M5), so the live Vite app never meets `Pressing`. PB 5 backend can run during the port (migration 009); PB 14 becomes migration 010.
3. Pressing can be skipped: Printing → Completed stays allowed (tarpaulins, stickers); apparel goes through Pressing.
4. LAN tablets: yes. Both servers bind to `0.0.0.0`; `CORS_ORIGINS` lists `http://<shop-computer-ip>:3000`; API address resolved at run time (§2.1).
5. Branches: start-up scripts per branch are deferred to M5.

Still open: a Content-Security-Policy for `Web/` (needs `connect-src` for LAN addresses, tested on real tablets) — M5.
