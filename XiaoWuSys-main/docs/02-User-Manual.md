# 2026-SE-XiaoMei-Printing-Services

## Tab 2: User Manual

| Field | Details |
|---|---|
| **System Name** | XiaoWuSys — XiaoMei Printing Services ERP System |
| **Deployed / Local URLs** | Shop computer: `http://localhost:3000`<br>Tablets and phones on the shop Wi-Fi (LAN): `http://<shop-computer-IP>:3000` (for example `http://192.168.1.10:3000`)<br>AWS Amplify (cloud): `https://main.<amplify-app-id>.amplifyapp.com` (the address shown in the Amplify console after the first deploy) |
| **Organization Name** | XiaoMei Printing Services |
| **Address** | Agdao, Davao City, Davao del Sur, Philippines |
| **Owner** | Ana Marie Yu |
| **Prepared by** | Brost, Patrick William Y.; Costan, Enri Miguel L.; Costan, Enzo Gabriel L.; Morinomoto, Rin |

---

### How to take every screenshot in this manual

Every screenshot cue below is marked **[LIGHT-MODE SCREENSHOT GUIDE]** and follows the same three rules.

1. **Light Mode only.**
   - Look at the sun/moon button in the top bar. Its tooltip must read **"Switch to dark mode"**, which means the page is currently light.
   - On the login page, use the same toggle in the corner.
2. **Compact window, never wide-screen.**
   - Resize the browser to **1024 × 768**, or **960 × 720**. Do not maximise it.
   - In Chrome or Edge: press F12, then the device toolbar (Ctrl+Shift+M), then choose *Responsive* and type the size. Close DevTools before capturing, or capture only the page area.
   - Zoom must be 100%.
3. **The exact URL, login role and on-screen state** given in each cue.
   - Use demo data so no real customer details appear: in `XiaoWuSys-main/Backend` run `npm run demo`, and in `XiaoWuSys-main/Web` run `npm run dev`.
   - Then log in with the demo account named in the cue (`owner`, `admin`, `production` or `staff`). The demo password is printed by `npm run demo:seed`.
   - Demo mode is offline-only, so the connection bar shows an offline notice. For screenshots of actions that need the cloud (**Approve job order**, **Calculate quote**, status buttons, **Usage rates → Save usage rates**), use the normal online shop setup with test data instead.

---

## 1. Background of the System

- **Who it is for:** XiaoWuSys is the order, inventory and finance system of XiaoMei Printing Services, a custom printing and garment shop in Agdao, Davao City, owned by Ana Marie Yu.
- **What it replaces:** the paper job orders, hand counts of stock and end-of-month money tallies the shop used before. Instead, it gives one place where everyone in the shop can see:
  - which orders are due and how far along each one is;
  - what materials are on hand, what is already promised to other orders, and what needs restocking;
  - who has paid, how much is still owed, and whether the shop made a profit this month;
  - what was wasted, why, and how much it cost.
- **Where it runs:** on the shop computer, and opens in any browser on the shop's tablets and phones over Wi-Fi.
- **Without internet:** it keeps working. Work saved during an outage is marked **Pending sync** and sent to the cloud database automatically when the connection returns.
- **Who decides money matters:** only the Owner can set prices, give discounts, approve orders, void payments and see the profit-and-loss report.

## 2. Intended Users

| Role | Who in the shop | What they can do |
|---|---|---|
| **Owner** | Ana Marie Yu | Everything. In addition, only the Owner can set and calculate quotes, give discounts, approve job orders, cancel (void) orders, void payments, remove recorded expenses, and generate the Profit & Loss report. Her online changes prevail over conflicting offline edits. |
| **Admin** | Shop manager / office staff | Everything except the Owner-only decisions above. Manages accounts (except the Owner's), archives closed orders and customers, permanently deletes items from the Recycle Bin, records overhead expenses, and downloads the finance exports (orders, payments, waste). |
| **Production** | Printer, press and layout staff | Creates and edits orders, records payments, moves orders through Printing → Pressing → Completed, adjusts stock, logs misprints and losses, and manages the catalog and usage rates. |
| **Staff** | Counter / sales staff | Views the dashboard, the catalog and orders (read-only), and downloads the inventory list. Costs and finance figures are hidden. |

## 3. User Onboarding

### 3.1 Getting an account

There is no public sign-up. The Owner or an Admin creates each person's account on the **Accounts** page (see 4.7) and gives them a temporary password.

### 3.2 Opening the system

- **On the shop computer:** open `http://localhost:3000`.
- **On a tablet or phone connected to the shop Wi-Fi:** open `http://<shop-computer-IP>:3000`. The Owner or Admin can read the address in the shop computer's start-up window.
- **If the shop uses the cloud deployment:** open the AWS Amplify address.

### 3.3 Logging in

1. Type your **Username** and **Password**. The eye button shows or hides the password.
2. Press **Log in**. You land on the **Dashboard**.
3. **If the login fails:**
   - After 5 wrong passwords the account is locked for 15 minutes.
   - The message is the same for a wrong username and a wrong password, so a guesser learns nothing.
4. **Forgotten password:** ask the Owner or an Admin to reset it (4.7).

> **[LIGHT-MODE SCREENSHOT GUIDE] Login page** (replaces the UniPASS login screenshot on p. 5).
> - **Setup:** Light Mode; 1024 × 768 window (or 960 × 720).
> - **URL:** `http://localhost:3000/login`. Log out first, or use a private window.
> - **On screen:**
>   - the XiaoWuSys logo and the login card;
>   - type `owner` in Username and leave the password hidden (dots);
>   - no error banner.
> - **Capture:** the whole page, with the card centred.

### 3.4 Finding your way around

- **The top bar** shows these sections. You only see the ones your role may use.
  - **Dashboard:** everyone.
  - **Catalog:** everyone.
  - **Create Order:** Owner, Admin and Production.
  - **Orders:** everyone.
  - **Accounts:** Owner and Admin.
- **Which section you're in:** the current section is underlined and bold.
- **On phones and portrait tablets:** the sections are inside the menu button (☰) at the top left.
- **Your account menu** (your name, at the top right) has **Change my password** and **Log out on this device**. Logging out on one device does not sign you out elsewhere.
- **The connection bar** under the top bar tells you:
  - whether you are working online or on this computer's copy;
  - how many changes are waiting to sync;
  - it also offers **Sync now**.

> **[LIGHT-MODE SCREENSHOT GUIDE] Dashboard after login** (replaces the UniPASS dashboard screenshot on p. 7).
> - **Setup:** Light Mode; 1024 × 768 window.
> - **URL:** `http://localhost:3000/dashboard`.
> - **Login:** `owner` (demo data).
> - **On screen:**
>   - the top bar with **Dashboard** underlined;
>   - the summary cards (Open orders, Unpaid balance, Needs restocking, Overdue, Due in the next 7 days);
>   - the top of the Restock list.
> - **Capture:** scrolled to the very top.

---

## 4. Feature Usage

### 4.1 Dashboard

| | |
|---|---|
| **Purpose** | See the state of the shop at a glance: open orders, unpaid balances, items to restock, overdue and soon-due orders, payments received per month, the most used materials, orders by status, and (for the Owner/Admin) the waste and defect diagnostics. |
| **Prerequisite** | Logged in (any role). Costs and money figures are shown only to the Owner and Admin. |
| **Procedure** | 1. Click **Dashboard** in the top bar.<br>2. Read the summary cards at the top.<br>3. Click an order in **Overdue orders** or **Due in 7 days** to open it in **Orders**.<br>4. Use **Copy list** on the **Restock list** to paste it into a message to the supplier.<br>5. Use the download buttons to export **Inventory (Excel)**; the Owner/Admin also see **Orders (Excel)**, **Payments (Excel)** and **Waste (Excel)**.<br>6. Press **Refresh** to load the latest figures. |
| **Expected Result** | The cards and lists show the current figures. Each month's bar in *Payments received per month* shows its month and peso amount. When working offline, a notice says the numbers come from this computer's copy. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/dashboard`.<br>- **Login:** `owner`.<br>- **On screen:** scroll down so **Payments received per month**, **Most used materials** and **Orders by status** are visible together. |

### 4.2 Catalog (materials and products)

#### 4.2.1 Searching the Catalog

| | |
|---|---|
| **Purpose** | Find a material and see its stock on hand, reserved stock, free stock, unit, supplier and low-stock status. |
| **Prerequisite** | Logged in (any role). |
| **Procedure** | 1. Click **Catalog**.<br>2. Type in **Search materials…** (name or supplier).<br>3. Narrow the list with **Filter by category** and **Filter by stock status** (for example *Low stock* or *Out of stock*).<br>4. Press **Clear filters** to see everything again. |
| **Expected Result** | Only matching items are listed. The stock badges read *In stock*, *Low stock* or *Out of stock*; the colour only adds to the word. The list updates live when someone else changes stock. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `production`.<br>- **On screen:** `shirt` typed in the search box, showing the *Custom Shirt* row. |

#### 4.2.2 Adding an Item

| | |
|---|---|
| **Purpose** | Add a new material or product to the catalog. |
| **Prerequisite** | Owner, Admin or Production. |
| **Procedure** | 1. On **Catalog**, press **Add item**.<br>2. Fill in **Item name \*** and **Category \***, then **Unit (what 1 means)** (for example pcs, ml, sheet) and **Supplier (optional)**.<br>3. Enter **Quantity in stock**, **Low-stock alert at**, **Unit cost (₱)** and **Selling price per piece (₱)**. The selling price is used to calculate quotes.<br>4. Press **Add item**. |
| **Expected Result** | The item appears in the list. A name that already exists (ignoring spaces and capital letters) is refused, with the reason shown next to the field. Saved offline, it shows **Pending sync** until it reaches the cloud. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `production`.<br>- **On screen:** the **Add item** dialog filled in with *Item name* `Sublimation Ink (Cyan)`, *Category* `Consumable`, *Unit* `ml`, before pressing **Add item**. |

#### 4.2.3 Editing an Item

| | |
|---|---|
| **Purpose** | Correct an item's details, prices or low-stock level. |
| **Prerequisite** | Owner, Admin or Production. The item exists. |
| **Procedure** | 1. On **Catalog**, open the item's row menu and choose **Edit details**.<br>2. Change the fields you need.<br>3. Press **Save changes**. |
| **Expected Result** | The row shows the new values. If someone else changed the same item in the meantime, the system says so and shows their version instead of overwriting it. Every edit is kept in the hidden audit trail. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `admin`.<br>- **On screen:** the edit dialog open for *Custom Shirt*, with the **Selling price per piece (₱)** field showing `280`. |

#### 4.2.4 Deleting an Item and the Recycle Bin

| | |
|---|---|
| **Purpose** | Remove an item you no longer use, with a way to undo it. |
| **Prerequisite** | Moving to the bin and restoring: Owner, Admin or Production. **Delete forever** and **Empty Recycle Bin**: Owner or Admin. Both need an internet connection. |
| **Procedure** | 1. Open the item's row menu and choose **Move to Recycle Bin**, then confirm.<br>2. To undo, press **Recycle Bin** at the top of the Catalog and press **Restore** on the item.<br>3. To remove it for good, press **Delete forever** on that item, or **Empty Recycle Bin**, then confirm. |
| **Expected Result** | The item leaves the catalog but stays in the Recycle Bin until restored or deleted forever. Items used by past orders or losses are archived instead of deleted, so order history never breaks. Items left in the bin are cleaned up automatically after the retention period. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `admin`.<br>- **On screen:** the **Recycle Bin** side panel open with one item listed, showing **Restore** and **Delete forever**. |

#### 4.2.5 Importing from Excel or Google Sheets (CSV)

| | |
|---|---|
| **Purpose** | Add many catalog items at once from a spreadsheet. |
| **Prerequisite** | Owner, Admin or Production. The spreadsheet is saved as CSV (Excel: *File → Save As → CSV*; Google Sheets: *File → Download → CSV*). |
| **Procedure** | 1. On **Catalog**, press **Import**.<br>2. Press **Download template** to get a CSV with the right column headings, and fill it in.<br>3. Press **Choose CSV file** and pick your file.<br>4. Check the preview. Rows with a problem are marked.<br>5. Press **Add N item(s) to the catalog**. |
| **Expected Result** | Each row is added through the same rules as *Add item*. Rows the server refuses as duplicates are shown as **"Already in the catalog (skipped)"**, and a summary says how many were added. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `production`.<br>- **On screen:** the Import dialog with a 3-row CSV previewed, before pressing **Add 3 item(s) to the catalog**. |

#### 4.2.6 Setting Consumable Usage Rates (BOM)

| | |
|---|---|
| **Purpose** | Tell the system how much of each consumable (ink, transfer paper, thread…) one piece of a blank uses, and when it is taken from stock. The consumables are then deducted automatically when an order reaches that step. |
| **Prerequisite** | Owner, Admin or Production. The blank (for example *Custom Shirt*) and its consumables are in the catalog. Saving needs an internet connection. |
| **Procedure** | 1. On **Catalog**, open the blank's row menu and choose **Usage rates (consumables)**.<br>2. Press **Add a consumable**.<br>3. Choose the **Consumable**, and enter **Per piece** (up to 3 decimals, for example `12` ml or `1` sheet).<br>4. Choose **Taken from stock**: *Pressing* (taken when the order goes to Pressing, or to Completed if it skips Pressing) or *Completed*.<br>5. Repeat for each consumable, then press **Save usage rates**. |
| **Expected Result** | The rates are saved. When an order of 25 shirts reaches Pressing, 25 × 12 = 300 ml of ink and 25 sheets of paper are deducted once. If there is not enough on hand, only what is there is taken, and the order shows **"Short by … : stock ran out"** under **Consumables used**. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768. Use the online setup to show saving.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `owner`.<br>- **On screen:** the Usage rates dialog for *Custom Shirt* with two rows: *Sublimation Ink (bulk)* 12 per piece and *Transfer Paper (sheet)* 1 per piece, both *Pressing*. |

### 4.3 Adjusting Material Stock

| | |
|---|---|
| **Purpose** | Record stock received, stock taken for use, and stock lost or damaged outside an order. |
| **Prerequisite** | Owner, Admin or Production. |
| **Procedure** | 1. On **Catalog**, press **Adjust stock**, or use the item's row menu.<br>2. Choose the **Item \***.<br>3. Choose **Add stock** (a delivery) or **Subtract / record loss**.<br>4. For a subtraction, choose the **Reason**: taken / used, or lost / damaged. For a loss, choose **What happened? \*** from the standard list and add **Notes (optional)**.<br>5. Enter the **Quantity \*** and press **Add to stock**, **Subtract from stock** or **Record loss**. |
| **Expected Result** | The stock on hand changes and every screen updates live. Stock can never go below what is on hand or reserved: the server refuses with "Not enough stock". A loss is costed and classified (see 4.5, *Log misprint / material loss*). |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/catalog`.<br>- **Login:** `production`.<br>- **On screen:** the Adjust stock dialog with *Deli A4 Paper (pack)*, **Add stock**, quantity `10`. |

### 4.4 Creating a Custom Job Order

| | |
|---|---|
| **Purpose** | Record a new job order with its customer, deadline and materials, and reserve the stock for it. |
| **Prerequisite** | Owner, Admin or Production. The materials are in the catalog. |
| **Procedure** | 1. Click **Create Order**.<br>2. **Customer:** pick a saved customer (their mobile number is shown as `0917 123 4567`), or add a new one with **Full name \***, **Mobile number** and **Came from** (Facebook, walk-in…).<br>3. Set the **Production deadline \***.<br>4. **Quote (₱, optional):** Owner only. You can also set it later.<br>5. Under materials, press **Add material**, choose the item and the quantity needed. Repeat as needed.<br>6. Press **Create order**. |
| **Capacity halt (Delay / Cancel)** | If the free stock (on hand minus what other orders already reserved) cannot cover the order, the **Not enough stock for this order** dialog lists each shortfall. Choose one:<br>- **Delay order:** enter a **New production deadline \*** and press **Save as delayed**. The order is saved as *Delayed* and keeps no stock until it is resumed.<br>- **Cancel order:** the order is not made, and it is recorded as a lost sale. |
| **Bulk jersey roster (CSV / paste)** | After the order is created, open it in **Orders** and press **Bulk import roster (CSV / Excel)**.<br>1. Choose the **Catalog item (blank) for every row**, or *Not linked to stock (print details only)*.<br>2. Fill in **What is printed**.<br>3. Press **Choose CSV file**, or paste the rows (size, name, number, quantity) into **Or paste the rows here**.<br>4. Check the **Roster preview** and press **Add N row(s)**.<br>Every row is added, or none are; a problem is reported by row number, for example "Row 4: Quantity must be at least 1." |
| **Expected Result** | A success message names the order number (`XM-YYYY-NNNN`, or "saved on this computer (offline)" and "gets its number after sync"), the customer, the deadline and how many materials were reserved, then gives the next step. For the Owner: set the quote, record the downpayment (half of the quote), then approve. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]** (two captures)<br>(1) **Create Order form:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/orders/new`.<br>- **Login:** `owner`.<br>- **On screen:** customer *Agdao National High School*, a deadline 7 days ahead, and one material row *Custom Shirt × 50*.<br>(2) **Capacity halt:** same window and login.<br>- **On screen:** enter *Custom Shirt × 5000* and press **Create order**, so the **Not enough stock for this order** dialog appears with **Delay order** and **Cancel order**. |

### 4.5 Managing Orders, Quotes, Approval, and Production Stages

| | |
|---|---|
| **Purpose** | Find an order, set its price, approve it, and move it through production to completion. |
| **Prerequisite** | Viewing: any role. Editing and status changes: Owner, Admin or Production. Quote, discount, approval and cancelling: Owner only. Status changes, the quote, approval and archiving need an internet connection. |
| **Finding an order** | 1. Click **Orders**.<br>2. Filter and sort the list. Sort options include *Most urgent first*, *Deadline: soonest first* and *Status (workflow order)*.<br>3. To jump straight to one order, type only its number (for example `12` or `XM-2026-0012`) in the order-number box and press **Find order**.<br>4. Click the order number (or anywhere along the highlighted row with the › cue) to open its details panel. |
| **Calculate Quote & Discount** (Owner) | 1. In the order's **Quote** section, press **Calculate quote & discount**.<br>2. Choose no discount, a peso amount, or a percentage, and enter the **Reason (required)**.<br>3. Press **Preview** to see the line prices, the volume tier (5% off from 50 pieces, 10% off from 100), the subtotal, the discount and the total.<br>4. Press **Save quote**. |
| **Print Official Quote** | Press **Print official quote** to print or save as PDF a quote that shows the shop's details, the lines, the discount and the total. |
| **Approval and Jump-to-Section links** (Owner) | The **Job order approval** box lists what is still missing: a quote, the downpayment (half of the quote, from payments already synced to the cloud), at least one material, or enough stock. Each missing item has a **Go to the quote**, **Go to payments** or **Go to materials** link that scrolls to that section and focuses it. When nothing is missing, press **Approve job order** and confirm with **Approve job order**. Approval reserves the materials, and the quote is frozen from then on. |
| **Production stages** | Use the buttons at the bottom of the panel: **Start printing** → **Start pressing** (optional; tarpaulins and stickers can go straight to completed) → **Mark completed**. A delayed order shows **Resume (reserve stock)**. **Cancel order** (Owner) asks for a reason and releases the reserved stock. While a button works it shows a spinner and "Updating…". |
| **Pressing & Status History timeline** | **Consumables used** lists what was deducted at Pressing or Completed. **Status history** shows every move with who made it and when; it cannot be edited or deleted. |
| **Print job order / details** | **Print job order** prints the production sheet. **Add print details (size / name / number)** adds roster lines one at a time; **Edit details** / **Edit deadline or quote** changes the deadline, design link (Google Drive only) and other details. |
| **Log misprint / material loss** | In **Waste**, press **Log misprint / material loss**. Choose the **Material \***, **What happened? \*** and **Pieces ruined \***, then press **Record loss**. The system records the cost and its diagnosed cause (*Machine Failure*, *Human Error* or *Product Defect*). It warns if there is no free stock left to replace the ruined pieces. |
| **Archive / Restore Order** (Owner, Admin) | A completed or cancelled order can be archived with **Archive** (confirm **Archive order**): it is hidden and becomes read-only, but is never deleted. Turn on **Show archived** in Orders and press **Unarchive** to bring it back. |
| **Expected Result** | Each action shows a message naming the order and customer, what changed and the next step, for example "XM-2026-0012 is now Printing". Every screen showing that order updates live. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]** (four captures; all Light Mode, 1024 × 768)<br>(1) **Orders list.** URL `http://localhost:3000/orders`, login `production`. Show the list sorted by *Most urgent first*.<br>(2) **Quote preview.** Online setup. URL `http://localhost:3000/orders?order=<id>` (open a *Pending* order), login `owner`. Show the quote dialog with a 10% discount previewed.<br>(3) **Approval box.** Use the online setup, login `owner`. Show an order with the downpayment not yet complete, so **Go to payments** is visible.<br>(4) **Status history.** Login `production`. Show the *Intramurals* demo order (*Completed*) scrolled to **Status history** and **Consumables used**. |

### 4.6 Recording and Voiding Payments

| | |
|---|---|
| **Purpose** | Record money received for an order, print an acknowledgement, and (Owner only) reverse a payment recorded by mistake. |
| **Prerequisite** | Recording: Owner, Admin or Production, on an order that has a quote. Voiding: Owner, online. |
| **Procedure (record)** | 1. Open the order and scroll to **Payments**.<br>2. Enter the **Amount (₱)**, up to the remaining balance; **Pay full balance** fills it in.<br>3. Choose the **Type**: *Cash*, *GCash* or *Bank Transfer*.<br>4. Press **Add payment**. |
| **Print Payment Acknowledgement** | Press the printer button on the payment row. The acknowledgement shows the receipt number `AR-YYYY-NNNN`. A payment saved offline prints as *provisional* until its number arrives with sync. |
| **Owner Payment Void** | 1. Press **Void payment** on the row.<br>2. Enter the **Reason for voiding \***.<br>3. Press **Void payment**. If the void would leave an approved order below its downpayment, the system warns first; press **Void anyway** only if you are sure.<br>The original payment stays on record, and a negative reversing entry is added. |
| **Expected Result** | The paid amount, the balance and the payment status (*Unpaid*, *Partial*, *Fully Paid*, *Overpaid*) update. A payment saved offline shows **Pending sync**. If branches together overpay while offline, the order shows **Overpaid** and the Owner refunds the difference by hand. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/orders?order=<id>` for the demo order of *Agdao National High School* (₱45,000).<br>- **Login:** `owner`.<br>- **On screen:** the **Payments** section showing its two payments (₱22,500 Bank Transfer and ₱15,000 Cash), the *Partial* status and the remaining ₱7,500. |

### 4.7 Managing User Accounts and Roles

| | |
|---|---|
| **Purpose** | Give people access, change what they may do, and remove access when they leave. |
| **Prerequisite** | Owner or Admin, online. Only the Owner can manage the Owner role. Nobody can change their own account here. |
| **Procedure** | **Create:** press **New account**, then enter **Username \*** (no spaces, for example `rin.staff`), **Temporary password \*** (at least 8 characters, with a letter and a number) and **Role \***. Press **Create account**.<br>**Change role:** choose the new role on the person's row and confirm.<br>**Deactivate / Reactivate:** use the row's button and confirm. A deactivated person is signed out at once.<br>**Reset password:** choose **Reset password**, enter **Enter new password \***, press **Set new password**, and give the password to the person.<br>**Remove** (Staff and Production accounts only): hides the account and deactivates it. Turn on **Show removed** and press **Restore** to bring it back (still deactivated). |
| **Expected Result** | The list shows each account's role and *Active* / *Deactivated* / *Removed* badge. Changing a role or password signs that person out on every device. Their name stays on the work they did. |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/accounts`.<br>- **Login:** `admin`.<br>- **On screen:** the accounts list with the **New account** dialog open, *Username* `rin.staff` and *Role* `Staff` chosen, and the password hidden. |

### 4.8 Recording Overheads and Generating the Profit & Loss (P&L) Report ("Magic Button")

| | |
|---|---|
| **Purpose** | Record the shop's monthly running costs, and see whether the shop made a profit after **all** costs: materials used, consumables, waste and overheads. |
| **Prerequisite** | Recording and listing overheads: Owner or Admin. Removing an expense, and the P&L: Owner only. |
| **Procedure (overheads)** | 1. On **Dashboard**, scroll to **Overhead expenses**.<br>2. Fill in **Date \***, **Category \*** (*Rent*, *Electricity & Utilities*, *Salaries & Wages*, *Outsourced Printing / Embroidery*, *Equipment Maintenance* or *Other*), **Description \*** (for example "November rent") and **Cost (₱) \***.<br>3. Press **Record expense**.<br>Use **From** / **To** to list a period. |
| **Procedure (P&L)** | 1. On **Dashboard**, scroll to **Profit and loss**.<br>2. Choose **From** / **To**, or leave them empty for this month so far.<br>3. Press **Generate P&L**.<br>4. Press **Print P&L statement** to print or save as PDF, or **Download P&L (Excel)** for `pnl.csv`.<br>5. For the waste detail, use **Waste (Excel)** to get `waste.csv`. |
| **Expected Result** | The statement shows:<br>- payments received (after voids) and discounts given;<br>- blanks used by completed orders, at the cost kept when each order was completed;<br>- consumables taken, at the cost kept when taken;<br>- waste by cause, and overheads by category;<br>- total expenses, and **Net profit** or **Net loss**.<br>Past reports do not change when catalog prices change later. In the demo data, this month shows income ₱51,250, expenses ₱40,797 and a net profit of ₱10,453 (the expense figure depends on the cost data in the catalog). |
| **Screenshot Guide** | **[LIGHT-MODE SCREENSHOT GUIDE]**<br>- **Setup:** Light Mode; 1024 × 768.<br>- **URL:** `http://localhost:3000/dashboard`.<br>- **Login:** `owner` (demo data).<br>- **On screen:** after pressing **Generate P&L** with empty dates, the statement with **Net profit** in view, and the **Overhead expenses** card above it listing Rent ₱8,000, Electricity and water ₱3,500 and Two production staff ₱24,000. |

---

## 5. Workflow Guidance

The usual life of a job order:

1. **Create the order** (Production/Admin/Owner, 4.4).
   - The system checks stock first. If stock is short, delay the order with a new deadline, or cancel it.
2. **Add print details** (sizes, names, numbers), one by one or with the **Bulk import roster** (4.4).
3. **Set the quote** (Owner, 4.5).
   - Use Calculate quote & discount, which applies the volume tier and any discount with its reason.
   - Print the official quote for the customer.
4. **Record the downpayment** (4.6).
   - At least half of the quote, and it must be synced to the cloud.
   - Print the payment acknowledgement.
5. **Approve the job order** (Owner, 4.5).
   - The materials are reserved and the quote is frozen.
6. **Production:**
   - **Start printing**, then **Start pressing** (consumables are deducted), then **Mark completed** (blanks are used up and their cost is kept for the P&L).
   - Log any misprints along the way.
7. **Collect the balance** (4.6). When the order is paid and completed, archive it (Owner/Admin) to keep the list short.
8. **Month end** (Owner, 4.8): record the overheads, then **Generate P&L**.

**Working offline:**

- If the connection bar says the cloud is unreachable, keep working. New orders, payments, losses and stock changes are saved on this computer and marked **Pending sync**.
- They are sent automatically when the connection returns, or press **Sync now**.
- Some actions need the cloud and say so: production status changes (Start printing, Start pressing, Mark completed, Resume, Cancel), approval, calculating the quote, payment voids, archiving, permanent delete, account changes and saving usage rates.

## 6. Notifications and System Messages

| Message (as shown) | When it appears | What to do | Light-Mode capture cue |
|---|---|---|---|
| **Order created**: "XM-2026-0012 for Agdao National High School, due …; 2 materials reserved. Next: set the quote, record the downpayment (half of the quote), then approve." | After **Create order** succeeds online | Follow the next step | 1024 × 768, `/orders/new`, `owner`: create a small order and capture the result dialog |
| **Order created**: "… saved on this computer (offline). This order gets its order number when it syncs to the cloud." | Creating an order while offline | Nothing: it syncs later | Demo mode (offline), `/orders/new`, `production`: capture the result dialog |
| **Not enough stock for this order** | The capacity check finds a shortfall | Delay with a new deadline, or Cancel | See 4.4, capture (2) |
| **"Set a quote amount for this order first."** / **"The downpayment (half of the quote) is not complete yet."** / **"Add at least one material to this order."** | In the Job order approval box | Use the **Go to …** link beside it | See 4.5, capture (3) |
| **"Approval needs an internet connection, and the order must be synced to the cloud."** | Approving while offline or before the order synced | Reconnect, press **Sync now**, try again | Demo mode, an order's approval box, `owner` |
| **Pending sync** badge | On orders, payments, losses or expenses saved on this computer | Nothing: it syncs automatically | Demo mode, `/orders?order=<id>`: a payment row with the badge |
| **"Amount is more than the balance"** | A payment larger than what the order can still take | Enter at most the remaining balance | 1024 × 768, an order's Payments, `production`: enter an amount above the balance |
| **"Check the field marked below."**, with a red ⚠ message under the field | The server rejected a field (for example a duplicate item name) | Correct that field | `/catalog`, `admin`: add an item with an existing name |
| **"Not enough stock to resume …"** (button tooltip) | Resuming a delayed order without free stock | Restock first (4.3) | An order in *Delayed* status, `production`: hover the Resume button |
| **Your change was replaced** (override notice) | A higher role changed the same order while you were offline | Reload the order and re-check | Needs two devices; describe it in the text if not captured |
| **Account locked** / wrong password | 5 wrong passwords, or a wrong username or password | Wait 15 minutes, or ask an Admin | `/login`: enter a wrong password once and capture the message |
| **Session ended** (back to login) | The account was deactivated, its role changed, or its password reset | Log in again (or ask the Admin) | Not usually captured |

## 7. Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| A tablet cannot open the system | Not on the shop Wi-Fi, or the wrong address | Connect to the shop Wi-Fi and open `http://<shop-computer-IP>:3000`. Check that the shop computer's start-up window is still running |
| The page opens but nothing loads ("cannot reach the server") | The API (port 5000) is not running or is blocked by the firewall | Restart with `scripts/start-shop`. Allow Node.js through Windows Firewall on private networks |
| "Working offline" in the connection bar | The internet or the cloud database is down | Keep working; changes sync later. Press **Sync now** when the connection is back |
| **Approve** stays disabled | Something in the approval box is missing, or you are offline | Follow the **Go to …** links. Make sure payments show no *Pending sync* |
| A payment does not count toward the downpayment | It was saved offline and has not synced | Press **Sync now** and wait until the badge disappears |
| Stock looks wrong after a delivery | The delivery was not recorded | Use **Adjust stock → Add stock** (4.3) |
| A conflict appears in the connection bar | The same record was changed offline and online by equal roles | Owner/Admin: open the conflicts list and choose **Keep cloud version** or **Keep this computer's version** |
| Forgot password | — | Ask the Owner or an Admin to reset it (4.7) |
| The Accounts or P&L section is missing | Your role does not include it | Ask the Owner |

## 8. Frequently Asked Questions

- **Can I use XiaoWuSys on my phone?**
  - Yes. Every screen fits a phone or tablet, and buttons are at least 40px tall on touch screens.
  - Open the shop computer's address while connected to the shop Wi-Fi.
- **What happens if the internet goes down?**
  - You keep working on the shop computer's copy, and changes are marked *Pending sync*.
  - Nothing is lost: everything is sent to the cloud when the connection returns.
- **Why can't I approve an order, change a price or void a payment?**
  - These are the Owner's decisions (authority limits).
  - Approval also needs a quote, a downpayment of at least half the quote that is synced to the cloud, and at least one material.
- **Why does an order say "gets its order number after sync"?**
  - Order numbers (`XM-YYYY-NNNN`) are given by the cloud database, so that two branches never use the same number.
  - Receipt numbers (`AR-YYYY-NNNN`) work the same way.
- **Can a deleted item come back?**
  - Yes. A deleted item goes to the Recycle Bin until it is restored or deleted forever.
  - Archived orders and customers are never deleted.
- **Will changing a price change last month's P&L?**
  - No. The cost of blanks and consumables is kept at the moment they are used.
- **Who can see money figures?**
  - Owner and Admin. Staff see counts and statuses only. The P&L is Owner-only.
- **How do I switch between light and dark mode?**
  - Use the sun/moon button in the top bar. The choice is remembered on that device.

## 9. Support Team

| Name | Role | Contact |
|---|---|---|
| Costan, Enri Miguel L. | Project Lead / Full-Stack Developer (back end, database, sync) | emlcostan@addu.edu.ph |
| Costan, Enzo Gabriel L. | Full-Stack Developer / QA (testing, deployment) | eglcostan@addu.edu.ph |
| Brost, Patrick William Y. | Front-End Developer (screens, UI/UX) | pwybrost@addu.edu.ph |
| Morinomoto, Rin | Documentation and Requirements Analyst | Ateneo de Davao University (through the project lead) |
| Ana Marie Yu | Client / Owner, XiaoMei Printing Services | XiaoMei Printing Services, Agdao, Davao City |

*Adviser:* Sir Antonio Bulao II / Sir Adrian Ablazo. *Panelists:* Genesis Emmanuel Gonzales, Greo Ochoa.
