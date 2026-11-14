# Porting audit: Dashboard (Batch M4)

Steering: `docs/nextjs-migration-steering.md` §3.4.
Source: `Frontend/src/Dashboard.jsx` (frozen Vite MVP).
Target: `Web/app/(app)/dashboard/page.tsx` → `Web/components/dashboard/dashboard-screen.tsx` + `dashboard-parts.tsx`; types and month label in `Web/lib/reports.ts`.
API: `GET /api/reports/dashboard`, `GET /api/reports/export/{inventory,orders,payments}.csv` (`Backend/routes/reports.js`).

Categories: **1. Presentation** (port freely) · **2. Formatting** (must call client-core) · **3. Rule** (must already be an API field; must not exist in `Web/`).

**Result: no category-3 logic lives in `Web/`.** Each MVP rule-like expression is either an API field or a `can()` call on server-sent capabilities. `npm run check-rules` passes (`no-role-checks`, `no-rule-math`).

## 1. Data and refresh

| MVP expression | Category | In `Web/` |
|---|---|---|
| `api('GET', '/reports/dashboard')` in `useEffect` on `tick`, `refreshKey` | 1 | `useApi()` in `useEffect` keyed on `tick` + `syncGeneration` (reloads after a sync) |
| `refreshKey` bumped by `App.jsx` on `inventory_updated` | 1 | `useSocketEvent('inventory_updated', reload)` |
| App-level 30 s inventory poll while the socket is down | 1 | `useFallbackPolling(reload, 30_000)`; the hook runs only while the socket isn't `live` |
| `errorText(body, 'The dashboard could not be loaded.')` | 2 | `errorMessage()` (`Web/lib/api.ts`, wraps client-core `errorText`) |
| `data.source === 'local'` → offline banner | 1 | Same; `source` is the server's answer |
| A failed refresh replaced the figures with an error | 1 | The last figures stay on screen with the error above them |

## 2. Permissions

| MVP expression | Category | In `Web/` |
|---|---|---|
| `FINANCE_ROLES = ['Owner', 'Admin']`; `FINANCE_ROLES.includes(userRole)` | **3** | **Removed.** `can(user, 'view_finance')` from `@xiaowu/client-core/permissions`, which reads the capabilities sent at login |
| `canSeeMoney && orders.overpaid.length > 0` | 3 → API | `orders.overpaid.length > 0` only. The server returns `[]` to accounts without `view_finance` (`reports.js`), so the panel follows the server's rows |
| Orders / Payments export buttons shown for `canSeeMoney` | 1 (hide/show from capability) | `can(user, 'view_finance')`; the server still answers 403 (`requireRole(FINANCE_ROLES)`) |

## 3. Figures (all computed by the server)

| Figure | MVP | Source field | In `Web/` |
|---|---|---|---|
| Overdue / due in 7 days lists | rendered | `orders.overdue`, `orders.due_this_week` (server compares deadlines to Manila `today`) | `OrdersTableCard` |
| Open orders | rendered | `orders.open` | KPI card |
| Unpaid balance + count | rendered | `orders.outstanding_balance`, `orders.unpaid_count` | KPI card (`view_finance` only) |
| Per-order balance | rendered | `brief().balance` | `peso(order.balance)` |
| Overpaid amount / total | rendered | `overpaid[].overpaid_by`, `orders.overpaid_total` | `peso(...)` in the red panel |
| Payment status | — | `brief().payment_status` | `PaymentStatusBadge` (tokens) |
| Restock list, free stock, suggested amount | rendered | `inventory.restock[]` (`free`, `suggested_order`, `stock_status`) | Restock table |
| Out-of-stock count | rendered | `inventory.summary.out_of_stock` | Banner + KPI footnote |
| Income per month | rendered | `income_by_month[]` | Bar list (`view_finance` only) |
| Top materials | rendered | `top_materials[]` | Table |
| Count per status | rendered | `orders.by_status` | `OrderStatusBadge` + count |

## 4. Expression by expression

| MVP expression | Category | In `Web/` |
|---|---|---|
| `r.stock_status === 'out_of_stock' ? d.pillOut : d.pillLow` and its label | 3 (state → look) | `lookFor(STOCK_STATUS, r.stock_status)` + `STOCK_STATUS[...].label` from `Web/lib/ui-tokens.ts`; no comparison in the component |
| `orders.overdue.length ? '#b91c1c' : '#166534'` card colours | 1 | `tone` names mapped by `TONE_CLASSES` (`ui-tokens.ts`) |
| `PIN_NAMES = 4`; `restock.slice(0, PIN_NAMES)`; `restock.length - PIN_NAMES` "and N more" | 1 (counting list rows, not stock) | Same, in `LowStockBanner` |
| `restock.length === 1 ? 'material needs' : 'materials need'` | 2 | Same wording |
| `maxIncome = Math.max(1, ...amounts)`; bar `height = amount / maxIncome * 120` | 1 (bar length) | Native `<progress value={amount} max={busiestMonth \|\| 1}>`; the browser draws the bar and nothing is divided in code |
| `peso(m.amount).replace('.00', '')` bar label | 2 | `peso(m.amount)` |
| `monthLabel(ym)` (`toLocaleDateString`) | 2 | `monthLabel()` in `Web/lib/reports.ts` (display only) |
| `formatDateTime(data.today, { withTime: false })`, `generated_at.slice(0, 19)` with `utc` | 2 | Same client-core `formatDateTime` |
| `formatDateTime(o.production_deadline, { withTime: false })` | 2 | Same |
| `orderNumber(o)` (XM number or "New order") | 2 | Same, client-core `orders.js` |
| `peso(...)` everywhere | 2 | Same, client-core `format.js` |
| `toLocaleString()` on counts | 2 | Same |
| Row `onClick={onOpenOrders}` (opened the Orders tab, not the order) | 1 | Row click + order-number `<Link>` to `/orders?order=<order_id>`, which opens the M3 `OrderDetailSheet` directly |
| `downloadFile({ ..., path: '/reports/export/<kind>.csv' })` → `ResultDialog`, with `r.offline` note | 1 | `downloadFile()` from `Web/lib/api.ts` (not re-implemented) → `ResultDialog`, same offline note |
| Restock "Copy list" via `copyText()` → `ResultDialog` | 1 | `copyText()` from `Web/lib/print.ts` (not re-implemented) → `ResultDialog`; date via `formatDateTime(data.today)` (shop date, not the browser's clock) |
| Sticky low-stock pin `top: 2.75rem`, `role="status"` `aria-live="polite"` | 1 | Sticky below the shell header via `--shell-offset` (measured by `AppShell`), same ARIA, anchor to `#restock-list` |
| Status chips `"{status}: {n}"` | 1 | `OrderStatusBadge` + count |

## 5. Checked by hand vs not

- Checked by reading the code: every value on screen comes from a response field or from `can()` on server-sent capabilities.
- Decision flip (by reading the code): if the server returns `overpaid` rows, the panel shows for any account. If `capabilities` lacks `view_finance`, the money cards, chart and finance exports hide. If a restock item's `stock_status` changes, the badge follows the token for it.
- **Not** checked in a browser in this batch: see the M5 parity checklist in `docs/migration/m5-parity-signoff.md`.
