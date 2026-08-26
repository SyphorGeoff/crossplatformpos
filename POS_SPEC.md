# Aireus POS EDGE — wire contract & port spec

Ground truth: `/Users/geoffreymarshall/Documents/ISIS/aireus_posclient_sql_nocoredata`
(the shipped Objective-C ISIS POS client, target **ISIS**). Every outbound
request this app makes has a matching line there, cited file:line, and is
live-verified against enox before being marked resolved. Doctrine, sources, and
the fabricated-artifact warnings are the same as the KDS project
(`../WEBKDS_PORT_GUIDE.md`); `Sr_Simulator version 10.0` is feature/design
inspiration only, never protocol truth.

**Architecture:** one React/TS codebase → web + Android + iOS (Capacitor),
platform seams (`http`, `storage`, `device` reused from the KDS). Definitions
are plain typed record arrays in memory + storage cache — **no Core Data, no
ORM** (the iPad's Core Data was stripped years ago; what remained is object
instantiation that is morally arrays-of-dictionaries). Offline = serialize
open checks to storage and flush on reconnect (the KDS command-queue pattern),
NOT a local database.

**Scope rules (Geoff):** credit-card processing deferred (new modern
interfaces come later); room-charge/PMS kept; gift-card & loyalty limited to the
native Aireus in-house (HBroker) versions — third-party gateways (Givex,
DataCandy, Paytronix, RepeatRewards…) left out. API extensions come only from
the ranked feature triage, designed deliberately (Jerry owns the phase-one XML
API expansion server-side).

---

## Chapter 1 — Activation & definitions sync  *(this slice)*

### 1.1 HBroker transport
XML `POST` to `{enterprise_server_url}/ISISPOS/HBroker`, `Content-type: text/xml`
(getAPIServerAddress, TerminalConfigManager.m:810; app-path const :90/:117).
`enterprise_server_url` derives from the enterprise code by Aireus convention
(`ENOX` → `https://enox.aireus.com`), matching the KDS.

### 1.2 Tokens (TerminalConfigManager.m)
| Step | Message | Fields | Source |
|---|---|---|---|
| Enrol | `Token_Request Token_Type="New_Terminal"` | ISIS_Ver, Terminal_UID (persistent 10-digit GUID), Enterprise_Code (=enterprise id), Enterprise_Login, Enterprise_Password | :886 |
| Session | `Token_Request Token_Type="Standard"` | ISIS_Ver, Store_ID, Terminal_POS_ID, Terminal_UID, empty Emp_POS_ID/Pin/Login/Password, Enterprise_Code | :916 |

Token read from `<Security_Token_Value>`; `<error>`/`<Status_Text>` = refusal.
(Note: POS uses **New_Terminal**, where the KDS used New_KDS.)

Between enrol and session comes store-list → terminal-list → **Terminal_Assignment**
(next slice — same pattern as the KDS activation, different message set).

### 1.3 Definitions sync (DefinitionManager.m)
- **Catalog:** 51 definition types in client order (DefinitionManager.m:163-640),
  captured verbatim in `src/model/definitions.ts` (name → table).
- **Request** (makeDefXML, :2640): `Definition_Request Override_Revision_Seq="0"
  Definition_Type="X"` with ISIS_Ver, Store_ID, Current_Revision_Seq, optional
  change_sequence, Security_Token. Three shapes: full (Current_Revision_Seq=0),
  incremental+change_seq, incremental.
- **First load** (`firstLoad`, syncDataSynchNoThread :1043/:1082): pull all 51
  fully; record each table's max Revision_Seq.
- **Incremental** (getAllSeq :1773, `Definition_Type="All"`): fetch the per-table
  sequence map, compare to stored, re-pull only tables whose server seq is
  higher. Language/Localization special-cased; Tender/Adjustment changes flag a
  tender refresh (:1123-1140).
- **Offline** (:1790): `COMMFAIL` falls back to the cached copy (the `.def`-file
  cache; here, storage-backed `def.<table>.v1` + `defseq.v1`).

Implemented: `src/protocol/hbroker.ts`, `src/protocol/activation.ts`,
`src/protocol/defsync.ts`, `src/model/definitions.ts`. Tests: `tests/hbroker.test.ts`.

### 1.4 Live verification — VERIFIED end-to-end against enox (2026-08-26)
Full chain drove live: sign-in → store (Aireus Cafe·3) → POS terminal list
(Is_Licensed=="1") → assignment → Standard token → all 51 definitions synced
(36 tables, ~2006 rows: Menu_Item 159, Chain 52, DiningTable 49, Employee 12,
Employee_Job 30, +1413 images). Resolved:
1. Token element is `<Security_Token_Value>` for New_Terminal & Standard. ✓
2. Definition row parsing (array-valued child under the type wrapper) works on
   every real response. ✓
3. `Definition_Type` full-pull rows carry Revision_Seq; the "All" incremental
   map path is coded but not yet exercised live (no def changed mid-session) —
   the one remaining item to confirm on a real edit.
4. Terminal_Assignment success is `Message_Status Status_Code="100"`
   ("Terminal Authorized. Please Wait") — NOT an error. Interpret by numeric
   Status_Code (>=400 = failure); an <error> element is failure.

---

## Chapter 2 — Menu browse  *(M1, this slice)*

The read side of the ordering screen: revenue-center pick → screen-group tabs →
item grid, with drill-in sub-screens and a flat item search. Building the actual
check (tap-to-add + forced modifiers + send) is M2; here an item tap opens a
detail sheet. Verified live against enox (store 3 / terminal "Geoff 1").

### 2.1 Data model (live field names, store 3)
- **Menu_Item**: `POS_ID`, `Name`, `Price`, `Ask_For_Price` (open price),
  `Screen_Group_POS_ID` + `Secondary_Screen_Group_POS_ID` + `Screen_Group_POS_ID3..10`
  (placement), `Screen_Sort_Order`, `Category_POS_ID`, `Print_Group_POS_ID`,
  `Is_Modifier`, `Screen_Chain_POS_ID` (forced-modifier chain, M2), `Hide_From_Store`.
- **Screen_Group**: `POS_ID`, `Name`, `Sort_Order`, `Skip_Carousel` (root gate),
  `Parent_Screen_Group_POS_ID` + `parent_Screen_Group_POS_ID2..10`, `button_color`.
- **Revenue_Center**: `POS_ID`, `Name`, `enable_screen_group_filter`.
- **RevenueCenter_Screen_Group**: `RevenueCenter_ID`, `Screen_Group_ID`,
  `always_filter`, `filter_start_time`/`_end_time`, `monday..sunday` — a
  **hide/schedule** table, NOT a membership join.
- **Terminal**: `Screen_Group_POS_ID` (default section), `Default_RevenueCenter_POS_ID`.

The ordering grid is built from Menu_Items grouped into Screen_Groups —
**`AIScreen_Button` is the check/payment toolbar's programmable buttons, not the
menu grid** (a common misread).

### 2.2 Navigation rules (ground truth → `src/model/menu.ts`)
- **Root tabs** = Screen_Groups with `Skip_Carousel != 1` passing the RC gate,
  by `Sort_Order` then `Name` (CheckViewController.m:2791-2811). Depth is NOT the
  predicate — a parented group can be a root tab (e.g. "Fresh Desserts").
- **Initial selection** = terminal `Screen_Group_POS_ID` / `Default_RevenueCenter_POS_ID`,
  each falling back to the first available (CheckViewController.m:2906-2923).
- **RC visibility** (`shouldShowScreenGroup:` 21966-22025): filter off → all
  groups show; filter on → a referenced group is hidden (`always_filter`) or
  gated to its day/time window.
- **Sub-screens** = Screen_Groups whose parent slot matches the current group
  (ItemsTableViewController.m:1328-1397). **Items** = Menu_Items whose primary or
  secondary Screen_Group slot matches, `Hide_From_Store` dropped, by
  `Screen_Sort_Order` then Name (ItemsTableViewController.m:1400-1461).

Implemented: `src/model/catalog.ts` (typed views over the synced rows),
`src/model/menu.ts` (resolver), `src/views/Menu.tsx` (browse UI).
Tests: `tests/menu.test.ts` (9). Live-confirmed: 6 root tabs (Beverages…Beer
Menu), terminal default RC Coffee Bar, drill-in + breadcrumb, open-price items,
modifier badge, search excludes modifiers. Note: store 3 has a mutual parent
link (Main Dishes ⇄ Breakfast) — faithfully reproduced, matching the iPad.

---

## Chapter 3 — Order entry & send to kitchen  *(M2, this slice)*

Tap items to build a check, run forced-modifier chains, and fire the check to
the kitchen — closing the loop with the shipped KDS. Verified live end-to-end
against enox (2026-08-26): a FinancialCheck POST was accepted (Status_Code 100)
and the server assigned/incremented the check number (200001 → 200002).

### 3.1 Check model (client-local, offline doctrine)
`src/model/check.ts` — a check is a flat array of line items mirroring the KDS
wire shape: each `CheckLine` has a kind (M item / Mo modifier / Co course),
`indentLevel`, and modifiers carry `parentKey` (→ the item line). Persisted to
storage on every change (`useCheck`), flushed on send — never a local database.

### 3.2 Add + forced-modifier flow (CheckViewController.m:17284-17476)
- `Menu_Item.Screen_Chain_POS_ID` → `Screen_Chain` → `Chain` rows (by Sort_Order)
  → each `Chain.Screen_Group_POS_ID` is a modifier screen. `src/model/menu.ts`
  `modifierSteps()` resolves them; `ModifierFlow.tsx` walks them.
- Per step: `Min`/`Max` selection, `Is_Forced` (no Skip) vs optional (Skip),
  `max_Free_Count` (first N picks priced 0, extras keep price — CheckViewController
  .m:16869-16878). Modifiers attach as their own lines under the parent.

### 3.3 Send message — FinancialCheck (FinancialCheckManager.m:12841-13158)
POST to `/ISISPOS/HBroker`, `Content-type: text/xml`. `src/protocol/order.ts`
`buildFinancialCheck()` reproduces it byte-for-byte:
- `<FinancialCheck …attrs…>` (Guest_Count, Check_Name, Is_New, …) + header in
  emission order: ISIS_Ver, BusinessDate_ID, Store_ID, Security_Token, Check_No,
  Employee_POS_ID, check_key, is_Mobile, RevenueCenter_POS_ID, Opened_On, active_At.
- One `<Tray>` per service round (Tray_Number, Terminal_POS_ID, Sent_On,
  Employee_POS_ID, traykey) holding the round's unsent lines.
- `<LineItem … Type="M" lineitemkey=…>` with Guest_Num, Quantity, Line_Number,
  MenuItem_POS_ID, Line_Amount; **modifiers are Type="M" lines carrying
  `Parent_LineItem_ID` + `Parent_Tray_Number`** pointing at the parent's
  Line_Number/Tray. Escaping: `&`→`&amp;`, `'`→`&apos;`, newline→`&#xA;`.
- **Success = `<Message_Status Status_Code="100">`.** (Status_Code is an XML
  *attribute* — the response parser was fixed to capture attributes, which also
  hardened the Terminal_Assignment check.)
- Routing to kitchen/printer is **server-side** (by RevenueCenter + each item's
  print groups); the client sends one check.

### 3.4 Session coordination (all `Transactional_Request` POSTs to /ISISPOS/HBroker)
- **BusinessDate_ID** (`resolveBusinessDate`): `Trans_Type="BusinessDate"` →
  `/BusinessDates/Business_Date[]`; pick the row whose (EndsAt−24h, EndsAt] window
  contains now (the feed carries future dates — live-confirmed bdid 90042 for
  2026-08-26). Required; empty ⇒ not-ready.
- **Check number** (`fetchHighestCheck` + `nextCheckNo`):
  `Trans_Type="HighestCheck"` (with BusinessDate_ID + Terminal_POS_ID) →
  `/HighestCheck/Check_Number`; next = highest+1, or `{terminalId}0001` when none.
- **Employee**: any `Employee.Emp_POS_ID` populates `Employee_POS_ID`; no
  client-side clock-in is required to send. `useEmployee` signs a server in.

Implemented: `src/model/check.ts`, `src/state/useCheck.ts`, `src/state/useEmployee.ts`,
`src/protocol/order.ts`, `src/views/{CheckPanel,ModifierFlow,Menu}.tsx`.
Tests: `tests/order.test.ts` (10). Live-verified: employee sign-in, tap-to-add,
3-step modifier chain (single + multi-select + free-count), send → Status 100,
check-number coordination, offline check persistence.

---

## Chapter 4 — Payments  *(M3, this slice)*

Settle a check: cash, room charge, and the native Aireus gift/loyalty. Credit
cards are deferred (stubbed, disabled in the UI); third-party gift/loyalty
gateways and live PMS posting are out of scope. Verified live against enox
(2026-08-26): cash settle, room-charge (offline) settle, and a native gift
`<Payment>` all round-tripped (Status_Code 100 / real PaymentResponse).

### 4.1 Tender model & routing
- `Tender` kind flags (Tender.m): `Is_Cash`, `Is_Credit`, `Is_GiftCert`,
  `is_Loyalty`, `roomCharge`; `payment_Driver` selects an external processor
  ("" = native/plain). Classified in `src/model/catalog.ts` (`tenders()`).
- Processor is Store-level: `GC_Processor`/`loyalty_Processor` — native when the
  string contains "isis"/"aireus" (store 3: `GC_Processor="ISISGiftCard"` → native
  gift; `use_Loyalty=0` → no loyalty here). `storeConfig()` + `isNativeGift`/
  `isNativeLoyalty` gate to native-only; non-native card/gift/loyalty is stubbed.

### 4.2 Payment → tender line & settle
- A payment is a `Type="T"` LineItem (Tender_POS_ID, Line_Amount, Tip_Amount,
  Change_Given, Transaction_Ref=gift balance, Reference=room/auth) —
  FinancialCheckManager.m:7224/12255. `src/model/check.ts` holds tenders +
  balance math; `src/protocol/order.ts` `xmlTenderLine`.
- **Settle is the same `<FinancialCheck>` POST re-sent** with `Is_Closed="1"` /
  `Is_Settled="1"` and the tender lines' tray — NOT a separate message
  (FinancialCheckManager.m:13824/23664). Success = Status_Code 100. Balance due =
  grand total (subtotal + tax; see §4.5).
- Change: `amountTendered − balance` (Overpay_Is_Tip folds overpay to tip on the
  iPad; here overpay is change). Split/partial = multiple tender lines; the check
  closes when the balance reaches 0.

### 4.3 Cash & room charge
- Cash: amount pad / fast-cash → change → tender line → settle.
- Room charge: prompt room number (+ last name) → recorded **offline** as a
  tender line (Reference="Room N …"). The live PMS post is a separate host
  (`http://{PMS_Address}:{PMS_Port}/OraclePMSProxy/OracleProxy`, `<PostRequest/>`,
  PMSManager.m:2998/3475) — the builder is in `src/protocol/payment.ts` but not
  auto-fired (external hotel system).

### 4.4 Native gift / loyalty  (`src/protocol/payment.ts`)
- `<Payment Type="…">` POST to **HBroker** (CreditCardManager.m:653/1168):
  gift `PrePaidBalance`/`PrePaidSale`, loyalty `LoyaltyBalance`/`LoyaltyRedeem`
  (native only; third-party uses `ai_givex.jsp`/`ai_loyalty.jsp` — never here).
  Response `<PaymentResponse Status="…">` (children Balance/TextResponse/…).
- **The check must be posted before a `<Payment>`** — the server rejects an
  unknown check with Status_Code 500 "Check not posted"; the client posts the
  check first (verified live: bogus card → `Status="Failure"` "Account doesn't
  exist", i.e. the native processor accepted and processed the message).

Implemented: `src/protocol/payment.ts`, `src/protocol/order.ts` (settle + Type=T),
`src/model/check.ts` (tenders/balance), `src/views/PaymentView.tsx`. Tests:
`tests/order.test.ts` (settle + tender lines). Deferred: live PMS posting,
credit-card processing, loyalty (off in store 3).

### 4.5 Tax computation  (`src/model/tax.ts`, TaxManager.m)
Chain: `Menu_Item.Menu_Item_Tax_Group_POS_ID` → `Menu_Item_Tax_Group`
(`Tax_Pack_POS_ID`, `Round_Down`) → `Tax_Pack` (up to 5 `Tax_DefN`: Rate,
`TRG_POS_ID`, Threshold, Rebate, `Is_Compounded`) → `Tax_Report_Group`
(`Is_Inclusive`). Store 3: group 1 = Sales Tax 10% exclusive, group 2 = No Tax.
- Per def (TaxManager.m:1861-1899): exclusive `tax = base × rate/100` (two-step
  ×4dp, round-down if the group's `Round_Down`); inclusive `tax = base −
  base/(1+rate/100)`. Compound (Def2..5, :1930) folds the prior def's tax into
  the base. Accumulate per report group at 4dp; **round each group to 2dp at
  assembly** then sum — exclusive → grand total, inclusive → already in prices
  (:1105-1150). Grand total = round2(subtotal) + round2(exclusive tax).
- Wire: one `<Tax_Group_Amt><Tax_Report_Group_POS_ID Is_Exempt="…">{id}</…>
  <Tax_Amount>…</Tax_Amount></Tax_Group_Amt>` per report group on the
  FinancialCheck (FinancialCheckManager.m:8274-8298); no separate total element.
- Verified live: Big Burger $10 → tax $1.00 → total $11.00; cash $11 settle with
  the tax breakdown → Status_Code 100. Tests: `tests/tax.test.ts` (9).
  Simplified (not in store 3, documented in tax.ts): Item_Count_Trigger>1,
  per-def Threshold/Rebate tiering, multi-inclusive combined-rate reconciliation.
  Whole-check tax exemption (remove report groups) is modeled but no UI yet.

---

## Chapter 5 — Table service & floorplan  *(M4)*

Verified live against enox (2026-08-26): floorplan with live `Open_Checks`
occupancy; open a table → order → hold; resume an occupied table via lock+read;
tax on resumed checks.

### 5.1 Floorplan (`src/views/Floorplan.tsx`)
- `Dining_Room` (rooms) + `DiningTable` (`X_Coordinate`/`Y_Coordinate`,
  `Dining_Room_POS_ID`, `Name`, `seat_count`, `unselectable`) — tables placed on
  a 768-wide canvas by coordinate (SectionView.m). Catalog accessors in
  `catalog.ts` (`diningRooms`/`diningTables`/`empDiningRooms`).
- Occupancy is **derived from `Open_Checks`**, not a table field. Status order
  matches the iPad: allergy → held → printed → occupied → open.

### 5.2 Open checks & resume (`src/protocol/tables.ts`)
- **List** (`fetchOpenChecks`): `Transactional_Request Trans_Type="Open_Checks"`
  → `/Open_Checks/Open_Check[]` (Table_POS_ID, Check_Number, check_key,
  Emp_POS_ID, Held_Item, Print_Count, Is_Allergy, Last_Modified_Time).
- **Resume** an occupied table: `lockCheck` (`Set_Check_Lock Lock="1"`, its own
  DTD; 100=ok, 200=already locked) → `readCheck`
  (`Trans_Type="FinancialCheck"` → `<FinancialChecks>`), parsed back into a
  `Check` (items+modifiers by Parent_LineItem_ID/Tray, tenders by Type="T"),
  preserving `check_key` so edits update the same check. `unlockCheck` on leave.
- **Bind & hold**: a table check carries `DiningTable_POS_ID`
  (order.ts emits it); Send/hold is the ordinary `<FinancialCheck>` POST with
  `Is_Closed="0"` — any such check keeps the table occupied (no dedicated hold
  message). Settle closes it and returns to the floor. `Line_Amount` is now the
  extended amount (unit × qty), matching the iPad.

Implemented: `src/protocol/tables.ts`, `src/views/Floorplan.tsx`; `Menu.tsx`
floor/order switch, `useCheck.loadCheck`.

### 5.3 Transfer check → table
Move a table check to another table: re-POST the `<FinancialCheck>` with a new
`DiningTable_POS_ID` (recon D — no dedicated Transfer message). "Move" enters a
transfer mode on the floorplan; picking a table re-POSTs and the server frees the
old table / occupies the new. Verified live: #200006 moved table 4 → table 3.
(Provenance reference lines and transfer-to-employee are deferred.)

---

## Later chapters (planned, per milestone)
M1 store/terminal pick + assignment + menu browse ✓ · M2 order entry + send to
kitchen (closes the loop with the shipped KDS) ✓ · M3 payments (cash + room
charge + native Aireus gift/loyalty; CC seam stubbed) ✓ · M4 table service /
splits / transfers / floorplan · M5 manager functions / timeclock / cash mgmt.
Each ends with an enox side-by-side against the iPad. M1–M2 run entirely on the
existing XML API — no dependency on the server rewrite.
