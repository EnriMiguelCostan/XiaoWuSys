# Porting audit: Catalog (Batch M2)

Steering: `docs/nextjs-migration-steering.md` §3.4. Written after the port (backfilled in the M5 PR), by reading both sides.
Source: `Frontend/src/InventoryCatalog.jsx`, `InventoryImport.jsx`, `RecycleBin.jsx` (frozen Vite MVP).
Target: `Web/app/(app)/catalog/page.tsx` → `Web/components/catalog/` (`catalog-screen.tsx`, `inventory-table.tsx`, `item-form-dialog.tsx`, `stock-dialog.tsx`, `import-dialog.tsx`, `recycle-bin-sheet.tsx`), with `Web/lib/inventory.ts` and `Web/hooks/use-inventory-snapshot.ts`.
API (`Backend/routes/inventory.js`): `GET /api/inventory` → `{ source, fetched_at, summary, categories, items }`; `POST /api/inventory`; `PATCH` / `DELETE /api/inventory/:id`; `POST /api/inventory/:id/adjust`, `/loss`, `/restore`; `DELETE /api/inventory/:id/permanent`; `GET /api/inventory/recycle-bin`; `POST /api/inventory/recycle-bin/empty`; `GET /api/reports/export/inventory.csv`.

Categories: **1. Presentation** (port freely) · **2. Formatting** (must call client-core) · **3. Rule** (must already be an API field; must not exist in `Web/`).

**Result: no category-3 logic lives in `Web/`.** The MVP had ten rule expressions on this screen (two role lists, a duplicate-name rule in two places, a stock check, three number limits, and two money sums). Each was removed or replaced by a server answer. `npm run check-rules` passes. The temporary capability mapping and the two missing figures recorded here after M2 were closed in Batch M6 (§1, §2).

## 1. Permissions

| MVP expression | Category | In `Web/` |
|---|---|---|
| `STOCK_EDIT_ROLES = ['Owner', 'Admin', 'Production']`; `canEdit = STOCK_EDIT_ROLES.includes(userRole)` | **3** | **Removed.** `canEditInventory(user)` = `can(user, 'edit_inventory')` in `Web/lib/inventory.ts` |
| `PURGE_ROLES = ['Owner', 'Admin']`; `canPurge = PURGE_ROLES.includes(userRole)` | **3** | **Removed.** `canPurgeInventory(user)` = `can(user, 'purge_inventory')` |
| Buttons hidden by `canEdit` / `canPurge` | 1 | Same, from the two helpers above. Express answers 403 anyway |

**Closed in Batch M6.** After M2 the backend guarded inventory with role lists of its own, so `Web/` borrowed `create_order` and `manage_accounts`, which happened to cover the same roles. The backend now has `edit_inventory` (Owner, Admin, Production) and `purge_inventory` (Owner, Admin) in `services/domain/permissions.js`; `routes/inventory.js` guards its routes with `rolesWith(...)` of those two, and `Web/lib/inventory.ts` checks the same two. Login and `GET /api/auth/me` send them in `capabilities`, so nothing is borrowed any more.

## 2. Stock numbers and money

| MVP expression | Category | In `Web/` |
|---|---|---|
| `stockValue(item) = quantity_available * unit_cost` (row column, sort key) | **3** (money maths) | **Removed** as maths. The "Stock value" column shows `peso(item.stock_value)`, which the server computes per item (`withAvailability()`, Batch M6). Sorting by it compares the server's figures (presentation) |
| Footer `totals` (`reduce` over on hand, reserved, free, value) | **3** (stock and money maths) | **Removed.** No totals footer |
| `totalUnits = items.reduce(...)` ("N units on hand" under Total items) | **3** (stock maths) | **Removed** as maths. The card shows `summary.total_units` from the server (Batch M6) under `summary.total_items` |
| Whole-catalog value | — (new) | `peso(summary.stock_value)`, computed by the server |
| `item.quantity_available_net`, `item.stock_status`, `summary.*` | 1 (server's answer) | Same fields, displayed as sent |
| `STATUS_META` colours and labels | 1 | `STOCK_STATUS` + `TONE_CLASSES` / `TONE_EDGE` in `Web/lib/ui-tokens.ts` |
| `peso(item.unit_cost)` | 2 | Same client-core call |
| `toLocaleString()` on counts | 1 | Same |

What staff still lose compared with the MVP: the totals row over the filtered list. The per-row stock value and the "units on hand" line returned in Batch M6, as server figures (`item.stock_value`, `summary.total_units`). Against an older server that does not send them, the column shows "—" and the line is left out.

## 3. Add and edit item

| MVP expression | Category | In `Web/` |
|---|---|---|
| `nameKey()` duplicate check against the loaded items (add and edit), with its own "Duplicate item" dialog | **3** (copy of the server's name rule) | **Removed.** The server answers `409`; its message is shown next to the form in the warning tone |
| `toWholeNumber()`: whole numbers of 0 or more, blocking submit | **3** (duplicated server limit, §3.1) | **Removed.** `toNumberInput()` only checks "is it a number". The server answers `400 VALIDATION_FAILED` |
| `toMoney()`: 0 or more, at most 2 decimals, rounding the value | **3** (duplicated limit and money rounding) | **Removed.** The typed value is sent as is; the server validates |
| Name `.replace(/\s+/g, ' ')` before sending | 1 (input format) | `trim()` only; the server normalizes names |
| Edit: send only changed fields plus `expected_version` | 1 | Same |
| "No changes" warning | 1 | Same |
| `409 EDIT_CONFLICT` → "Changed by someone else" title | 1 (shows the server's code) | The server's message is shown in the form (warning tone for any 409) |
| `maxLength`, `min`, `step` on inputs | 1 (input format) | `TEXT_MAX`, `WHOLE_NUMBER_MAX`, `MONEY_INPUT_MAX` from `Web/lib/input-limits.ts` |
| `COMMON_UNITS`, category `datalist` | 1 | Same (`Suggestions`) |
| `offlineSuffix(data)` when `data.source === 'local'` | 1 (server's answer) | `offlineNote(data)` |
| Quantity not editable in Edit | 1 | Same; the hint points to Adjust stock |

## 4. Add / subtract stock, record loss

| MVP expression | Category | In `Web/` |
|---|---|---|
| `adjust.action === 'subtract' && qty > item.quantity_available` → "Not enough stock" | **3** (stock rule) | **Removed.** The server answers `409 INSUFFICIENT_STOCK`; its message is shown in the form |
| `!qty \|\| Number.isNaN(qty)` → "whole number greater than 0" | **3** (duplicated limit) | Reduced to "Enter how many, as a number." Range is the server's |
| `reason === 'lost'` → `POST /loss`, otherwise `POST /adjust` | 1 (which endpoint the person chose) | Same |
| Fixed reason strings sent with the request | 1 | Same, plus an optional "What happened?" note on a loss |
| "Currently N in stock (M reserved). Low-stock alert at T." | 1 (server fields) | Same |
| Success text with `data.item.quantity_available` | 1 | Same |

## 5. Import from Excel

| MVP expression | Category | In `Web/` |
|---|---|---|
| `existingKeys` / `seen` sets using `nameKey()` → "Already in catalog" / "Repeated in file" before sending | **3** (copy of the server's name rule) | **Removed.** Every readable row is sent; a `409` is shown as "Already in the catalog (skipped)" |
| `toNumber()`: non-negative, whole numbers, money rounded to 2 decimals | **3** (duplicated limits and rounding) | **Removed.** `cellNumber()` strips `₱`, commas and `PHP`, and only checks "is it a number" |
| `HEADER_ALIASES`, `MAX_ROWS = 500`, 2 MB limit, `.csv` check | 1 (file handling) | Same |
| `parseCsv` | 2 | Same client-core call (`@xiaowu/client-core/csv`) |
| Template download built with a `Blob` and an `<a>` | 1 | `saveBlob()` from `Web/lib/api` (no second copy of the download code) |
| Row counters and the final summary | 1 (counting what the server answered) | Same, with a separate "skipped" count |

## 6. Recycle Bin

| MVP expression | Category | In `Web/` |
|---|---|---|
| Purge buttons disabled when `data.source === 'local'` | 1 (server's answer) | Same (`page.source === 'local'`) |
| `pages = Math.ceil(total / PAGE_SIZE)`, "Page N of M" | 1 (paging) | `hasNext = (pageNo + 1) * PAGE_SIZE < total` and "a–b of total" from `page.offset`. Paging only |
| Empty loop until `remaining` is 0 | 1 (repeats a server batch) | Same |
| `formatDateTime(item.deleted_at, { utc: true })` | 2 | Same |
| `retention_days` | 1 (server field) | Same |
| Restore / purge / empty → `ConfirmDialog` + `ResultDialog` | 1 | Same |

## 7. List, filters, live updates

| MVP expression | Category | In `Web/` |
|---|---|---|
| Search, category and status filters over the loaded snapshot | 1 | Same |
| `SORTERS`, `FIRST_DIR`, `aria-sort` headers | 1 | Same, without the `value` sorter (§2) |
| `LIST_PAGE = 50`, "Show more" | 1 | Same |
| `useNarrow()` hiding columns | 1 | Tailwind breakpoints |
| `recentlyChanged` highlight | 1 | Same, from `useInventorySnapshot()` |
| `LIVE_META`, "(this server only)" when `!cloudListening` | 1 | Same |
| Local `formatTime()` with `toLocaleTimeString` | 2 | **Fixed:** `formatDateTime()` from client-core (Manila wall clock) |
| `source === 'local'` offline banner | 1 (server's answer) | Same |
| `sync_status !== 'synced'` → "Pending sync" | 1 (server's answer) | Same |
| Export: `downloadFile(...)` + `ResultDialog` | 1 | Same helper, plus the offline note |

## 8. Outcomes

Successes and list-level failures (delete, export, restore, purge, empty) end in a `ResultDialog`. Server refusals inside an open form (item, stock, import file) appear next to the form through `FormProblem` (`role="alert"`), as steering §3.1 prescribes. This is deliberate and is not converted to a dialog.

## 9. Open notes

- The empty-catalog text for people who cannot edit named three roles. It was reworded in Batch M6 ("Items added by the people who manage the catalog will appear here."), so it cannot go stale when roles change.
- Not checked in a browser for this audit: see `docs/migration/m5-parity-signoff.md`.

## 10. Added in Batch M6 part 2 (new features, not ported from the MVP)

| Feature | What the server decides | What `Web/` does |
|---|---|---|
| Selling price (PB 11) | `selling_price` per item (validated like `unit_cost`; audited on edit) | One more number field in Add / Edit item and a "Selling price" column; the value is shown as sent |
| Usage rates (PB 15) | `GET /api/inventory/:id/consumable-rates` (rates with names, the consumables that may be chosen, the steps, `can_edit`); `PUT` checks every row (above 0, 3 decimals, no duplicates, not itself, still in the catalog), needs the cloud, and writes the inventory trail | "Usage rates (consumables)" in the row actions (`edit_inventory` only). The dialog lists rows, checks that amounts are numbers, sends the whole list and shows the server's answer. The rate x quantity maths and the deduction happen only on the server |

