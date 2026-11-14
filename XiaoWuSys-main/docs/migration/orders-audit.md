# Porting audit: Orders and Create Order (Batch M3)

Steering: `docs/nextjs-migration-steering.md` §3.4. Written after the port (backfilled in the M5 PR), by reading both sides.
Source: `Frontend/src/OrdersPage.jsx` and the "Create Order" tab of `Frontend/src/App.jsx` (frozen Vite MVP).
Target:
- `Web/app/(app)/orders/page.tsx` (`RequireCapability view_orders`) → `orders-screen.tsx`, `order-detail-sheet.tsx`, `order-sections.tsx`, `payments-section.tsx`, `shortage-table.tsx`, `status-badges.tsx`.
- `Web/app/(app)/orders/new/page.tsx` (`RequireCapability create_order`) → `create-order-screen.tsx`.
- Helpers: `Web/lib/orders.ts`, `Web/lib/print.ts`.

API (`Backend/routes/orders.js`, `customers.js`): `GET /api/orders` (server-side filter, sort, paging); `GET /api/orders/:id` → `{ source, order, items, payments, totals, stock_check, allowed_actions }`; `POST /api/orders` (with `resolution` for a halted order); `POST /api/orders/:id/approve`; `PATCH /api/orders/:id/status`, `/details`, `/design`; `POST /api/orders/:id/items`, `/payments`; `GET` / `POST /api/customers`.

Categories: **1. Presentation** (port freely) · **2. Formatting** (must call client-core) · **3. Rule** (must already be an API field; must not exist in `Web/`).

**Result: no category-3 logic lives in `Web/`.** The MVP already took its buttons from `allowed_actions`, but it still worked out the downpayment in centavos, validated and rounded money, and checked dates and quantities itself. All of that was removed. `npm run check-rules` passes.

## 1. Permissions and buttons

| MVP expression | Category | In `Web/` |
|---|---|---|
| `actions = orderActions(detail)` (approve, statuses, `edit_deadline`, `edit_quote`, `link_design`, `add_items`, `record_payment`, `print_receipt`) | 2 (client-core reading a server field) | Same call; every button and editor follows it |
| `canSetQuote = can(user, 'set_quote')` | 2 | Same |
| Create Order tab shown to everyone (the server refused the save) | 1 | `RequireCapability capability="create_order"`; the "New order" button uses `can(user, 'create_order')`. Express still decides |
| Orders tab shown to everyone | 1 | `RequireCapability capability="view_orders"` |
| `403` on approve → fixed text "Only the Owner can approve job orders." | 1 | Not special-cased. The Approve button only renders when `actions.approve` is true, and any refusal shows the server's message |
| `['Pending', 'Delayed'].includes(order.production_status)` choosing between two quote hints | 1 (wording from a server value) | One fixed hint: "Only the Owner can change the quote, and only before approval." |

## 2. Approval and the downpayment

| MVP expression | Category | In `Web/` |
|---|---|---|
| `toCentavos(n) = Math.round(Number(n) * 100)` | **3** (money maths) | **Removed** |
| `requiredC = toCentavos(totals.downpayment?.required ?? Math.ceil(quoteC / 2) / 100)` (local 50% fallback) | **3** (the downpayment rule) | **Removed.** Only `totals.downpayment.required` from the server. Without it the approval panel is not shown |
| `paidC < requiredC` → "… `peso((requiredC - paidC) / 100)` more to go" | **3** (money maths and a decision) | **Removed.** `dp.met` from the server decides; the text is "The downpayment (half of the quote) is not complete yet." The exact amount still to pay appears in the server's `402` answer |
| `quoteC <= 0` → "Set a quote amount first" | **3** | `!dp.required` (server figure) |
| `percent = Math.min(100, Math.floor(paidC / requiredC * 100))` for the bar | **3** (money maths) | **Removed.** `<progress value={dp.paid_synced} max={dp.required}>`: the browser draws the ratio, no arithmetic in code |
| `unlinked = items.filter((i) => !i.inventory_id).length` → blocking note | **3** (pre-empting a server check) | **Removed** as a blocker. The server answers `422 ITEMS_NOT_LINKED_TO_STOCK`. The per-line "not linked to stock" tag stays (display) |
| `order.sync_status !== 'synced' \|\| detail.source === 'local'` → "needs an internet connection" | 1 (server's answers) | Same |
| `payments.filter((p) => p.sync_status !== 'synced').length` → note | 1 (counting server flags) | Same, as a note that does not block |
| `detail.stock_check && !detail.stock_check.sufficient` + `shortfallLines()` | 2 (server field + client-core text) | Same |
| `blocking = problems.filter((p) => !p.includes('do not count until'))` | 1 | Two lists (`blocking`, `notes`) instead of filtering by text |
| `AWAITING_APPROVAL = ['Pending', 'Delayed']` choosing when the approval box shows | 1 (which panel to show for a server status) | Same list in `Web/lib/orders.ts`, and also requires `totals.downpayment`. The Approve button itself still needs `actions.approve` |
| Approve answers: `402`, `409 INSUFFICIENT_INVENTORY` / `EDIT_CONFLICT` / `ALREADY_APPROVED` / `ORDER_LOCKED`, `422`, `503` | 1 (shows the server's codes and figures) | Same branches. The `402` text uses the server's `remaining`, `total_paid`, `required_downpayment`, `total_quote_amount` through `peso()` |
| Resume disabled while `stock_check` is short | 1 (server's answer) | Same |

## 3. Payments

| MVP expression | Category | In `Web/` |
|---|---|---|
| `amount <= 0 \|\| Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6` → "Check the amount" | **3** (duplicated limit) | **Removed.** Only "is it a number". The server answers `400` |
| `amount: Math.round(amount * 100) / 100` | **3** (money rounding) | **Removed.** The typed number is sent as is |
| `actions.max_payment` as the cap and "Pay full balance" | 1 (server field) | Same: `max={actions.max_payment}` and `setAmount(String(actions.max_payment))` |
| `actions.payment_blocked_reason` | 1 (server text) | Same |
| `PAYMENT_EXCEEDS_BALANCE` → warning and reload | 1 | Same |
| `totals.remaining ?? totals.balance` | 1 | `totals.remaining` |
| `totals.payment_status === 'Overpaid'` → warning with `overpaid_by` | 1 (server's status and figure) | Same, through `peso()` |
| `PAYMENT_STATUS_META` colours | 1 | `PAYMENT_STATUS` in `Web/lib/ui-tokens.ts` |
| `PAYMENT_TYPES = ['Cash', 'GCash', 'Bank Transfer']` | 1 (options; the server validates the value) | Same list in `Web/lib/orders.ts` |
| Success text: `peso(amount)` (the typed value) | 2 | `peso(data.payment?.amount ?? value)` (the saved value first) |
| Receipt no. or `RECEIPT_AFTER_SYNC` | 1 | Same |
| `printReceipt` using `receiptHtml` | 2 | Same client-core builder, opened by `Web/lib/print.ts` |

## 4. Deadline, quote, design link, print details

| MVP expression | Category | In `Web/` |
|---|---|---|
| Quote: `q < 0 \|\| …2 decimals…` check, `Math.round(q * 100) / 100` | **3** (duplicated limit and rounding) | **Removed.** "Is it a number" only; the server validates |
| `q !== detail.order.total_quote_amount` (number compare) | 1 | Text compare against the loaded value, then the number is sent |
| Edit form opens with `deadline < todayInManila() ? today : deadline`; `min={todayInManila()}` | 1 (input hint) + 2 (`todayInManila`) | Same. The server still decides whether a date is accepted |
| Print line: `!Number.isInteger(qty) \|\| qty < 1` | **3** (duplicated limit) | **Removed.** "Is it a number" only |
| `expected_version` on every write; `EDIT_CONFLICT` handling | 1 | Same |
| Design link `PATCH /design`, `type="url"` | 1 | Same |
| `order.stock_reserved` choosing the Stock label and confirm texts | 1 (server field) | Same |

## 5. Create Order

| MVP expression | Category | In `Web/` |
|---|---|---|
| Quote check and `Math.round(quote * 100) / 100` | **3** | **Removed** (as in §4). The quote is left out of the request when the field is empty or the person may not set it |
| `productionDeadline < todayInManila()` → "already passed" dialog | **3** (duplicated server rule) | **Removed.** `min={today}` on the date input is a hint; the server refuses a past date |
| `dayAfter(pendingOrder.production_deadline)` as the minimum for a delayed deadline | **3** (date rule worked out locally) | **Removed.** `min={today}`; the server decides whether the new deadline is acceptable |
| `MOBILE_PATTERN.test(...)`, digits-only input, 11-digit hint | 2 (client-core pattern, input format) | Same |
| Customer `409` with `existing` → reuse that customer | 1 (server's answer) | Same |
| `res.status === 409` → capacity halt | 1 | Narrowed to `409` **and** `error === 'INSUFFICIENT_INVENTORY'`, so other conflicts are not mistaken for a stock halt |
| Halt table: `needed`, `available`, `-{s.shortfall}` | 1 (server figures) | `ShortageTable`: the server's numbers, nothing subtracted here |
| Delay / Cancel → `POST /orders` again with `resolution` | 1 | Same |
| Material picker "(`quantity_available_net` available)" | 1 (server field) | "(N free to use)" |
| `missing_inventory_ids` mapped to item names | 1 | Same |
| Success text, `NUMBER_AFTER_SYNC`, `orderNumber()` | 2 | Same client-core calls |

## 6. List

| MVP expression | Category | In `Web/` |
|---|---|---|
| Status, customer, order-number filters and sort sent as query parameters | 1 (the server filters and sorts) | Same |
| `normalizeOrderNumber()` for the number search | 2 | Same |
| `hasNext = orders.length === PAGE_SIZE`; `offset = page * PAGE_SIZE` | 1 (paging) | Same |
| `SORT_OPTIONS`, `SORT_DEFAULT_DIR`, `aria-sort` headers | 1 | `ORDER_SORT_OPTIONS`, `SORT_FIRST_DIR` |
| `ORDER_STATUS_META` (filter options and colours) | 1 | `ORDER_STATUSES` for the filter; `ORDER_STATUS` tokens for the look. An unknown status still renders, in a neutral look |
| Detail as a pop-up held in state | 1 | Side sheet addressed by `?order=<order_id>`, so the Dashboard can link to it and Back closes it |
| `list.source === 'local'` banner, "Pending sync" tag | 1 (server's answers) | Same |
| Reload on `refreshKey` | 1 | Reload on `syncGeneration` and on `inventory_updated` (detail) |

## 7. Printing and Messenger

| MVP expression | Category | In `Web/` |
|---|---|---|
| `messengerSummary()`, `printJobOrder()` (text built from `order`, `items`, `totals`) | 2 | Moved to `Web/lib/print.ts`; figures go through `peso()` and `formatDateTime()`, HTML through `escapeHtml()`. No arithmetic |
| `copyText()` + `ResultDialog` | 1 | Same helper, not re-implemented |
| Pop-up blocked → error dialog | 1 | Same |

## 8. Outcomes

Successes (create, approve, status change, payment, edits) and list-level failures end in a `ResultDialog`; stock shortages open the shortage dialog. Server refusals inside an open form (create order, payment, details, design link, print line, halt choice) appear next to the form through `FormProblem` (`role="alert"`), as steering §3.1 prescribes. This is deliberate and is not converted to a dialog.

## 9. Open notes

- Several fixed sentences name the Owner ("The Owner will set the price.", "Only the Owner can change the quote…", "Waiting for the Owner to approve…", "by the Owner", "The Owner should review it…"). They are wording only: nothing compares a role, and the rules guard passes. They would go stale if another role were given `set_quote` or `approve_order`. A server-sent reason (like `payment_blocked_reason`) would remove them.
- `AWAITING_APPROVAL` and `ORDER_STATUSES` repeat the server's status names for display and filtering. PB 14 `Pressing` was added in Batch M6: one entry in `ORDER_STATUSES`, one token in `ui-tokens.ts` and one label in `STATUS_ACTION`. Which next-status buttons appear still comes only from `allowed_actions.statuses`.
- Not checked in a browser for this audit: see `docs/migration/m5-parity-signoff.md`.

## 10. Added in Batch M6 (new features, not ported from the MVP)

These screens did not exist in the Vite MVP. They follow the same rule: `Web/` renders decisions and collects input.

| Feature | What the server decides | What `Web/` does |
|---|---|---|
| Edit locks (PB 5) | Who gets, keeps or loses a lock (`editing_order` ack, `order_lock_revoked`), and `409 ORDER_LOCKED` on writes | Holds the lock while an edit form is open (`useOrderEditLock`, renewed every 60 s on the live socket, released on close), shows "being edited" from `locks_snapshot` / `order_locked`, and a `ResultDialog` when the lock is refused or taken over. No rank is compared in `Web/` |
| Owner override (PB 5) | `can_override` in the `409 EDIT_CONFLICT` answer; rank re-checked from the token on the locked row; `audit_log`; `order_overridden` to the replaced account | `ConfirmDialog` "Replace their changes with mine?" only when `can_override === true`, then the same body again with `override: true`. `order_overridden` ends in a `ResultDialog` |
| Sync conflicts (PB 5) | Rank rule during sync; `title`, `changed` and `keep_local_blocked_reason` per conflict; refusals such as `KEEP_LOCAL_NOT_ALLOWED` | Conflicts dialog from the connection bar for accounts with `manage_accounts`: Keep cloud / Keep this computer's version, each confirmed first; the second button is not offered when the server gives a blocked reason |
| Pressing and status history (PB 14) | `allowed_actions.statuses`, `status_history`, `order_updated` | "Start pressing" label, the timeline as sent, reload on `order_updated` (list, open order, Dashboard). An open edit form is never reloaded from under the person typing |
| Deadline flags (PB 16) | `deadline_flag` per order (shop-time calendar days) and `sort=priority` | `DEADLINE_FLAG` tokens and `DeadlineBadge`; "Most urgent first" sends `sort=priority`. No date is compared in `Web/` to decide urgency |

### Added in Batch M6 part 2

| Feature | What the server decides | What `Web/` does |
|---|---|---|
| Volume quote and discount (PB 11 / PB 12) | `allowed_actions.generate_quote` / `apply_discount` / `print_quote`; `POST /api/orders/:id/quote` works out every unit price, the tier, the subtotal, a peso or percent discount (reason required, never above the subtotal) and the total, in centavos; `dry_run` previews; saving writes `audit_log` | "Calculate quote & discount" panel: collects the discount (₱ or %) and reason, shows the server's preview (tier label, lines, subtotal, discount, total), then saves the same request. No peso is computed in `Web/` |
| Quote breakdown | `quote` in `GET /api/orders/:id` (`subtotal_amount`, `discount_amount`, `discount_reason`, `total_quote_amount`, and `lines` with each unit price and line total, or `null` when the stored prices do not add up) | Shows the three figures; a typed quote (Edit details) is audited on the server as `quote_overridden` |
| Official quotation | The same `quote` and `lines`, and `totals.downpayment.required` | `printOfficialQuote()` in `lib/print.ts`: a "Customer Quotation" separate from the job order. Without `lines` it lists the items without prices and only the totals. The footer says it is not an Official Receipt or an invoice |
| Consumables used (PB 15) | `consumables_deducted` (what each status change took, with `shortfall` when the stock ran out) and the status-change message | A list under the timeline, with a "Short by N" warning badge per shortfall |
| Roster import (PB 7) | `POST /api/orders/:id/items/bulk`: up to 500 rows checked ("Row N: …"), all added or none, stock reserved when the order holds its stock, `503` offline in that case | "Bulk import roster (CSV / Excel)": reads a file or pasted text with `parseCsv` (client-core), maps the Name / Number / Size / Quantity columns, previews, checks that quantities are numbers (empty = 1), links every row to the chosen catalog blank, sends one request and shows the server's answer. The row limit is not repeated in `Web/` |

