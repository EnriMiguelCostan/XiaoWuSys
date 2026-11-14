# Batch M5: parity sign-off and cutover record

Steering: `docs/nextjs-migration-steering.md` §4 (M5) and §3.3. Feature list: `README.md` "What it does".
Status: **automated checks and code review done; the side-by-side manual pass below is still open.** Cutover is signed off only when every box in §3 is ticked by a person.

## 1. Route parity (verified)

| Vite MVP | `Web/` route | Built in | Smoke test (`start-shop.ps1 -Demo`) |
|---|---|---|---|
| Login form | `/login` | M1 | 200 |
| Catalog tab | `/catalog` | M2 | 200 |
| Orders tab + detail pop-up | `/orders` (detail sheet via `?order=<order_id>`) | M3 | 200 |
| Create Order + capacity halt | `/orders/new` | M3 | 200 |
| Dashboard tab | `/dashboard` | M4 | 200 |
| Accounts tab | `/accounts` (`RequireCapability manage_accounts`) | M4 | 200 |
| `/` | redirects to the first section | M1 | 307 |

Every README feature was traced to its `Web/` implementation: live catalog with highlight, add/subtract stock, loss, Recycle Bin, CSV import/export, order number search, reservation + capacity halt, design link, payments with **Pay full balance**, receipt and job order printing, Copy for Messenger, approve with reason, downpayment warning, Overpaid warnings, connection bar + Sync now + pending/conflict counts, device logout, change password, dashboard exports, account management.

## 2. Server-decides checks (verified)

- `npm run check-rules` passes: no role-string checks, no money/stock arithmetic, no backend imports or env, one socket, polling only in the fallback hook.
- Every state comparison left in `Web/` reads a server value (`source`, `sync_status`, `payment_status`, `stock_status`, HTTP status, connection state from `/api/sync/status`). None derives a decision from numbers.
- Decision flip (by reading the code; to be repeated with a patched backend in §3):
  - `capabilities`: `can(user, cap)` gates finance panels, exports, nav and account management.
  - `allowed_actions`: `orderActions(detail)` gates every order button; `max_payment` sets the payment cap.
  - `assignable_roles`: Accounts row actions and role options.
  - `stock_status`: `STOCK_STATUS` tokens.
  - `payment_status`: `PAYMENT_STATUS` tokens and the Overpaid warning.
- API contract spot-check (demo): Admin's `assignable_roles` = Admin, Production, Staff (no Owner). Staff gets 403 on `/auth/users` and `orders.csv`. The dashboard returns `overpaid: []` with `source: "local"`.
- Outcomes:
  - Successes end in a `ResultDialog`. The change-password dialog shows its result inside its own modal with OK.
  - Server refusals inside open M2/M3 forms appear next to the form (`role="alert"`), as §3.1 prescribes. Accounts refusals use a `ResultDialog`, as in the MVP.
- Accessibility:
  - The connection bar and the low-stock pin are `role="status"` `aria-live="polite"`. Errors are `role="alert"`.
  - Dialogs are Radix (focus trap, Escape, labelled titles). Order rows on the Dashboard are clickable and the order number is a real link for keyboard users.
- No dead code: no unimported module under `components/`, `hooks/`, `lib/`. `PagePlaceholder` was removed in M4. ESLint reports no unused imports.

## 3. Manual pass still to do (both UIs side by side)

Run `scripts/start-shop.ps1 -Demo` and, in a second window, the frozen `Frontend/` (`npm run dev`, port 5173).

- [ ] Log in with **each of the four roles** on both UIs; the nav, buttons and panels match.
- [ ] Admin: Approve, set quote and Cancel are hidden. Owner rows on Accounts show "—".
- [ ] Staff: no money figures, no Orders/Payments exports, no Accounts link.
- [ ] Payment cap, **Pay full balance**, a provisional receipt (offline), reprint after sync.
- [ ] Dashboard: the low-stock pin sticks under the header while scrolling. "See restock list" scrolls to the list. Clicking an order row opens its detail sheet.
- [ ] Dashboard updates within seconds when stock changes in another tab. With the API stopped, it retries every 30 s and recovers on its own.
- [ ] Keyboard only: open and close every dialog; Tab reaches every action; Escape closes.
- [ ] `master-context-steering.md` §6 checks: Sync now offline ("Still offline"); a bad `DATABASE_URL` flips the bar to Offline; restoring it returns to Online within ~15 s.
- [ ] Decision flip with a patched backend (e.g. `allowed_actions.record_payment = false`, `capabilities` without `approve_order`): the UI follows with no other change.
- [ ] A tablet on the shop Wi-Fi at `http://<shop-computer-ip>:3000` after adding it to `CORS_ORIGINS`.
- [ ] Content-Security-Policy for `Web/` (steering §8, still open), tested on real tablets.

## 4. Cutover

- The README Quick start now launches `Backend/` (:5000) + `Web/` (:3000) through `scripts/start-shop.ps1` / `.cmd` / `.sh`.
- `Frontend/` stays frozen for one release as a fallback, then is removed in a follow-up PR.
- After cutover: PB 14 backend (migration 010), then the PB 5 + PB 14 UI in `Web/` (steering §5).
