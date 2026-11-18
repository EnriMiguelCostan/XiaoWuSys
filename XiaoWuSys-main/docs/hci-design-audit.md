# HCI design audit: Web/ (ergonomics, heuristics, WCAG 2.1 AA)

Scope: `Web/` and `shared/client-core/` (the frozen `Frontend/` was not touched). The server still makes every decision (steering §3.1): nothing in this pass computes money, stock or status in the browser, and `npm run check-rules` passes with no new exceptions.

## 1. What changed, by principle

### Norman's principles and the 4-state feedback

| Principle | Change | Where |
|---|---|---|
| **Feedback (in flight)** | Every main async button is disabled at once and shows a spinner and its own verb ("Saving…", "Approving…", "Archiving…", "Calculating…", "Updating…"). The button's own icon is hidden while the spinner shows. | `Button` `busy` prop (`components/ui/button.tsx`); `ConfirmDialog` `busyLabel`; 19 submit buttons; the order sheet's status buttons |
| **Feedback (pending)** | Records saved on this computer all carry the same **Pending sync** badge, with a tooltip explaining it (payments, losses and overheads used to say "offline"). "Given after sync" stays for receipt numbers. | `payments-section`, `waste-section`, `finance-sections` |
| **Gulf of evaluation (success / error)** | Outcomes name what happened, to which order and customer, where it was saved, and what comes next. "Order created" now says the order number or "saved on this computer (offline)", the customer, the deadline, and the next step. Status changes and approval name the order and customer, plus the next step. | `create-order-screen`, `order-detail-sheet` |
| **Gulf of execution (blocked actions)** | A blocker comes with a way to fix it. "Set a quote first" → **Go to the quote**. "Downpayment not complete" → **Go to payments**. "Add a material" → **Go to materials**. Payments blocked for lack of a quote → **Go to the quote**. The link scrolls to the section and focuses its heading. Which section it is comes from server fields, never from message text. | `jump-to-section.tsx`, `ApprovalPanel`, the Approve footer, `PaymentsSection` |
| **Signifiers** | Order rows (Orders list, Dashboard lists) show a chevron "open" cue, react to hover, and highlight the whole row while its order button or link has keyboard focus. | `orders-screen`, `dashboard-parts` |
| **Constraints / mapping** | Destructive steps are grouped apart from constructive ones (see Fitts below). | `order-detail-sheet` footer |

### Nielsen's 10 heuristics

| # | Heuristic | Change |
|---|---|---|
| 1 | Visibility of system status | Spinners and verbs on busy buttons; one consistent "Pending sync" badge; the current section is marked in the header. |
| 2 | Match with the real world | Mobile numbers are shown as people say them, `0917 123 4567`. Outcomes use the shop's words ("saved on this computer"). |
| 3 | User control and freedom | Cancel buttons keep their place and get 12px from the main action; "Keep order" / "Keep payment" stay the safe default. |
| 4 | Consistency and standards | Same pending badge everywhere; the same `Field` layout, required mark and error style in every form. |
| 5 | Error prevention | Destructive actions are separated by a divider and space; required fields are marked and explained. |
| 6 | Recognition rather than recall | "Fields marked * are required" on every form that uses the mark; jump links instead of "go and find the Quote section". |
| 7 | Flexibility and efficiency | Row links open with Enter **or** Space; touch screens get larger targets, desktop keeps its density. |
| 8 | Aesthetic and minimalist design | No new panels; the changes are spacing, wording and states. |
| 9 | Help users recognise, diagnose and recover from errors | Inline field errors on every form: an alert icon, the server's own words for that field (`details[].field` from `400 VALIDATION_FAILED`, via `fieldErrorsMap()`), and `aria-invalid` on the control. Covered: item form, new customer, deadline, stock change, payment, payment void, discount, loss, new account, password reset, overheads. The top banner stays for general errors; when every problem is already shown at its field it only says "Check the field marked below." (`bannerText()`). |
| 10 | Help and documentation | Hints are tied to their inputs with `aria-describedby`; tooltips on every icon-only button. |

### Cognitive laws and Gestalt

- **Miller's law (chunking):**
  - `formatMobile()` in `shared/client-core/format.js` (with `.d.ts` and a unit test) shows `09171234567` as `0917 123 4567`.
  - Used in the orders list, the order sheet, the customer picker and both printouts.
  - Forms still send the raw 11 digits, and anything that is not an 11-digit mobile number is shown exactly as stored.
- **Hick's law:** footers keep at most one primary action each; destructive actions are a separate, smaller group, so the main choice reads first.
- **Fitts's law:**
  - In the order sheet footer, destructive actions ("Cancel order") come first, then a divider and 16px, then the constructive steps, with the main one at the far right.
  - Dialog, alert and sheet footers put 12px (was 8px) between buttons.
  - Touch targets: see §4.
- **Gestalt proximity:**
  - `Field` keeps label, control, hint and error 6px apart (`gap-1.5`).
  - Separate fields are 16px apart (`space-y-4` / `gap-4`); the order sheet's details, print-details and payment forms and the overheads form were 12px.
- **Gestalt common region:** the jump link sits inside the note it resolves, so the blocker and its fix read as one unit.

## 2. Colour and contrast (WCAG 2.1 AA)

Measured with `npm run check-contrast` (`Web/scripts/check-contrast.mjs`), which also runs in CI (`.github/workflows/ci.yml`, web job, after `check-rules`) and in the AWS Amplify build, so a token change that drops below AA fails the build. The script converts the oklch tokens to sRGB and blends the translucent badge tints as browsers do. Every pair below now passes in **both** themes.

| Pair | Minimum | Before (light) | After (light) | Dark |
|---|---|---|---|---|
| `--warning` text on its 10% badge tint | 4.5:1 (SC 1.4.3) | 4.39 | **4.94** | 7.83 |
| `--muted-foreground` on muted surfaces | 4.5:1 | 4.34 | **5.27** | 5.83 |
| `--destructive` text on its tint (destructive buttons) | 4.5:1 | 3.99 | **5.13** | 4.63 |
| Input / select / toggle borders (`--input`) on page and card | 3:1 (SC 1.4.11) | 1.26 | **3.64** | 3.85+ (was 1.47) |
| Focus ring (`--ring`) | 3:1 (SC 1.4.11) | 2.59 | **4.85** | 4.18 |

The success, danger and info tones and body text already passed and were left unchanged. Card and table borders stay on the lighter `--border`, because they are decoration, not control boundaries.

**Meaning beyond colour (SC 1.4.1):**
- **Header:**
  - The current section has a 2px bar (under the tab; at the left in the phone menu), bold text and `aria-current="page"`, as well as its colour.
  - Links are 40px tall with 8px between them.
- **Required fields:**
  - A red `*` (`aria-hidden`) plus "(required)" for screen readers, and the form note.
  - Errors carry an icon and words, never colour alone.
- **Dashboard income chart:** each month's row already prints its month label and peso amount beside the bar, so the bar's length and colour are never the only way to read it.
- **Status, payment, stock and loss-cause badges:** each already carries its word ("Overpaid", "Machine Failure"); colour only adds to it.

## 3. Typography and reflow (SC 1.4.10, 1.4.12)

- **Headings:**
  - `CardTitle` is now a real heading (`<h2>` by default, `as="h1"` / `as="h3"` when needed), so card titles show up in heading navigation.
  - Each screen has one `<h1>`: the page title, or the card title on the login and "no access" screens. Cards are `<h2>`; sub-sections such as the order sheet's sections and "Orders by status" are `<h3>`.
  - Dashboard summary cards: the label is the `<h2>`, and the figure is a paragraph (it used to be the card title).
- **Sentence case:** labels shown in capitals are kept to three short words or fewer ("Order", "Customer", "Out of stock", "Paid / Balance"); everything else is sentence case.
- **Alignment and measure:**
  - Empty states and messages are start-aligned with `leading-relaxed` (catalog, recycle bin, usage rates, conflicts, orders, accounts).
  - Dialog, alert and sheet descriptions use `max-w-prose leading-relaxed`.
  - Alert dialogs no longer centre their text on phones.
- **No clipping:**
  - Buttons use minimum heights instead of fixed heights, `max-w-full` and `whitespace-normal`, so a long label wraps at 320px or 200% zoom instead of being cut off.
  - Badges wrap the same way.
  - Dashboard summary labels, figures and footnotes wrap instead of truncating.

## 4. Physical ergonomics (shop tablets and phones)

- **Touch targets (`pointer: coarse` only):**
  - Buttons, inputs, select triggers and options, toggles and menu items are at least **40px** tall; icon buttons are 40×40px.
  - Done once in the shared primitives (`components/ui/*`) with Tailwind's `pointer-coarse:` variant, so mouse-and-keyboard desktops keep today's density.
  - Confirmed in the built CSS (`@media (pointer:coarse)`).
- **Spacing:** adjacent controls keep at least 8px (`gap-2`); footer actions 12px.
- **No mystery icons:**
  - Every icon-only button has an `aria-label` and a matching visible `title` tooltip (6 added).
  - Sheet and toolbar actions keep their text labels.
- **Row affordances (orders list, dashboard lists):**
  - A chevron cue, hover and focus-within highlight.
  - The order number is the one keyboard control in each row: a real button (orders) or link (dashboard). Space opens the dashboard link too.
  - The `<tr>` itself is **not** made a second tab stop with `role="link"`: that would double every row's tab stops and hide the table's columns from screen readers. The single real control keeps both mouse and keyboard users covered.

## 5. Verification

- `shared/client-core`: `npm test`, 13 pass, including the new `formatMobile` test.
- `Web`: `check-rules` (no new exceptions), `check-rules:test` (33), `check-contrast` (all pairs pass; also in CI), `lint`, `typecheck`, `build`.
- `Backend`: `npm test`, 182 pass (no backend change).

**Not checked by hand:**
- a screen-reader pass (NVDA / TalkBack);
- a real tablet for the touch sizes;
- 200% zoom and 320px on every screen;
- the decision-flip check.

The contrast numbers are computed, not measured with a browser tool.
