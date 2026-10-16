# Aireus POS (cross-platform) — Implemented Features

The tracking list for features the iOS app has that the cross-platform POS must
match. The iOS Objective-C app is the only ground truth for behavior.

Base list: the "not implemented" items from QA run 2026-09-18 (the 2026-09-21
rerun had the same list minus Use Refire). Update a row's status as work lands.

**Status legend**

| Status | Meaning |
|---|---|
| Done | Built and verified live against the server |
| Built | Code complete with tests, awaiting live test |
| Partial | Some of the iOS behavior is in, the rest is not |
| Not started | Nothing built yet |
| Out of scope | Deliberately not ported |

Last updated: 2026-10-08

## Payments

| Feature | Status | Notes |
|---|---|---|
| Offline Credit Card | Built | Non-online credit tenders post as plain tender lines via an amount pad |
| Offline Credit Card Void | Built | Unsent tenders are removed; a posted tender (cash or offline card, pulled-back check) is voided with auth + reason as a negative Is_Void reversal, like iOS voidLineItem on a Type T line |
| Gift Card Activation | Not started | Wire type exists (PrePaidIssue), no UI |
| Gift Card Reload | Not started | Wire type exists (PrePaidReload), no UI |
| Gift Card VOID Redemption | Not started | |
| Gift Card VOID Activation | Not started | |
| Gift Card VOID Reload | Not started | |
| Advance Deposit (activate, reload, redeem, void) | Not started | |
| Offline credit card: overpay is tip, ask for tip | Built | Overpay_Is_Tip and Ask_For_Tip; a tip of 50% or more of the balance needs a manager |
| Online credit cards (preAuth, credit sale, void payments, add tips) | Not started | Online tenders show disabled |
| Divide by (then separate payment types) | Built | Count pad; each payment defaults to balance ÷ remaining ways |
| Payment approval (offline cc tenders) | Not started | |
| Apply a discount from the payment screen | Not started | |
| Credit Card Threshold (under $5.00, pay at table on/off) | Not started | |
| Max Check Amount | Built | Store max_check_amount; "Your check reaches max limit" |

## Ordering

| Feature | Status | Notes |
|---|---|---|
| Menu item affinity (pairing recommendation) | Built | Prompt before ringing an item with MenuItem_Affinity_POS_ID |
| Change quantity by pressing the number under "Qty" | Not started | |
| Change guest location by pressing the number under "G" | Not started | Change Guest exists in Edit Check |
| Double press an item to add a reference | Not started | |
| "Mods" button to add modifiers to an existing item | Not started | |
| Modifier Insertion | Not started | |
| Happy hour price before / during / after | Not started | |
| Timed item | Not started | |
| Wine Descriptor | Out of scope | Geoff, 2026-10-07 |
| Visual favorites | Built | "Favorites" tile first on the root screen: Top16 items plus pins |
| Order an item with toppings | Not started | |
| Modify an unsent item with toppings | Not started | |
| Select multiple items and change course | Built | Edit Check → Change Course, or a 1-second press on a check line; sent lines re-post print_Sort_Order |
| Revenue centre pills set the check's RC | Partial | Pills along the top of the order screen. Today they change the check's RC only while the check is empty (selectRc); with lines on the check they only switch the menu view. Wanted (Geoff 2026-10-09): pills replace the iOS Edit Check → Change Revenue Centre — re-assign the RC at any time, re-post the check, and switch the app to the new RC's settings (course picker/headers, screen-group filter, always-ask-for-tab, logout-after-payment, print routing). New check starts on the terminal's default RC. Master list O14–O18 |
| Rollup Mod Prices feature | Not started | |
| Show/Hide Inclusive Taxes feature | Not started | |
| Order an item with commission / "My Commission" | Not started | |

## Printing

| Feature | Status | Notes |
|---|---|---|
| Print every type of check and email a check | Not started | |
| Receipt printer and order printer redirecting | Not started | |
| Printer Selection for guest check and receipt | Not started | |
| Receipt Printer Selection | Not started | |
| Manual Print Group Selection in the manager menu | Out of scope | Manager-menu tile removed for good (Geoff 2026-10-16) |
| Press and hold print with unsent items | Not started | |
| Courses print on order chits | Built | Printer useCourse + course names, Others section, missing course = 6, guest-before-course |
| Course override prints properly | Built | Line override wins over the item default on chit and KDS |

## Manager menu / features

| Feature | Status | Notes |
|---|---|---|
| Void a pay in / pay out | Not started | |
| Use Refire | Done | Verified in the 2026-09-21 QA rerun |
| Add / change / remove a countdown (86) | Built | 2-second press on a menu tile: Order Item, Manage Qty, Remove Qty; badge and sold-out tile. iOS out-of-stock message to clocked-in staff not yet added |
| Open a closed check | Not started | Manager-menu tile kept, disabled until built |
| Return Mode | Not started | |
| Print Read (server read) | Out of scope | Terminal Read / Server Read tiles removed for good (Geoff 2026-10-16) |
| Flash Report and Labor Summary | Not started | |
| Log in to the back office from the manager menu | Out of scope | Back Office tile removed for good (Geoff 2026-10-16) |
| Logout After Payment feature | Built | Revenue center logoutAfterPayment returns to the login keypad after close |
| Create Tab From Table Layout feature | Not started | |
| Check For Messages On Sign In feature | Not started | BUG (Geoff 2026-10-16): the out-of-stock notice is sent but never RECEIVED/shown on Android, where iOS pops the alert — first deliverable of the messaging arc |
| Send and receive a message (internal and email) | Not started | Only the outbound check-transfer notice exists |
| KDS → POS broadcast message | Not started | Kitchen staff alert all staff via a new BULLETIN BOARD on the POS login screen, beside the pin pad (Geoff 2026-10-13); sent through the message API to all POS users; expires after ~10 min or when a user clears it. Not a fire |
| Kitchen message from a sent line | Not started | Long-press a sent/fired check line → pills with default notes (e.g. Delay) sent to every printer/KDS that printed that item: a note chit on paper, a message document on the KDS. Pill list to confirm with Paul |
| Manager transfer check from the manager menu | Not started | Transfer All button present, disabled |

## Hot list — must be bulletproof before it ships

| Item | Decision so far | Before it ships |
|---|---|---|
| Fire by waiter (Fire Course button) and KDS hold / unfired state (C07–C09) | Parked (Geoff 2026-10-13). Not every restaurant fires by waiter; the industry-standard flow is everything sent, then a "fire" item. The held/unfired status is a complication that must never appear at a site that doesn't use it, on either app. | Write a real spec, not Paul's MD. POS: add an optional revenue-centre flag (e.g. `fireCourse`); absent = no Fire Course button, headers show only pending/sent. KDS: already silent unless a printer carries `holdUnfiredCourses` — keep it that way. Decide whether "fire" also works as a plain menu item. Guard against the kitchen never making a held item because the server forgot. Optional on BOTH apps, default off. |

## Server bugs (back office / HBroker) — fix later

| Bug | Found | Effect on the POS | Status |
|---|---|---|---|
| Definition revision sequence not stamped on some tables: the "All" map reports 0 and the rows carry Revision_Seq 0 even after an edit. Confirmed on Adjustment_Department (Geoff 2026-10-13: added department Retail to "20% Gratuity", map stayed 0). Same shape on this store for DiningTable, Event, Language, Buttons. | 2026-10-13 | The POS cannot see these changes from the map, so, like iOS DefinitionManager, it re-pulls every 0-seq table on each revision sync (≈17 small pulls per keypad arrival) and compares rows to report them. Once the server stamps them the POS needs no change. | Open — server fix later |

## Current arc: long-press menu item

Goal: the long-press popup on a menu tile, iOS base first, then the pills from
Paul's LONGPRESS_ACTION_CATALOG.md. Items are taken one at a time as they come
up; prerequisites (like coursing) are built when a pill needs them.

| Item | Status | Notes |
|---|---|---|
| Popup: name, description, Order Item, Skip | Built | 2-second press, iOS MenuItemCellView parity |
| Popup: Manage Qty / Remove Qty (86) | Built | See 86 row above |
| Popup: Update Price / New Item (manager) | Parked | iOS definition edits; parked after the API expansion (Geoff 2026-10-13) until the API settles |
| 86: out-of-stock message to clocked-in staff | Built | On a manager set-to-zero (Manage Qty 0 or 86 from here): one internal Post_Message per clocked-in employee, Subject "Menu Item out of Stock: {name}", like iOS sendMessageForZeroMenuItem |
| Coursing (prerequisite for course pills) | Built (fire-by-waiter and KDS hold on the hot list, parked) | POS: course model, Adding-to picker, headers/chips/tints, Ordering Mode, Change Course, chit + KDS Co lines, waiter Fire Course. KDS: held lines, fire document, panel fire chip, auto-fire. Awaiting live test |
| Pill: course chips / pre-pick course | Built | C1–C10 chips on the item popup ring the item into that course |
| Pill: send to seat N | Built | Seat 1..N and Table pills ring to that seat |
| Pill: Add Mods | Built | Shown when the item has a modifier chain; opens it |
| Pill: allergen note | Built | Server roles; chips plus free text → Reference on the item line, printed under it on the chit and sent to the KDS |
| Pill: hold | Built | Rings the item held (Is_Held) |
| Pill: fire now | Built | Server roles; sends only this item's family now, other unsent lines wait for the next Send |
| Pill: split this item | Built | Rings, then opens divide-among-guests for that line |
| Pill: repeat last | Built | Counter roles; re-rings the item's latest line with mods, seat, course; shows minutes since it was rung |
| Pill: x2 / x3 / x5 | Built | Through the 86 stock gate and max-check guard |
| Pill: comp 100 / 50 / 25 | Built | Manager strip; uses the first percentage Adjustment named "comp" (open → all three, fixed → its own percent); adjust auth |
| Pill: override price | Built | Manager strip; price pad behind override-price auth |
| Pill: cost / margin | Built | Manager strip; from the feed's Cost element, shown only when Cost > 0 (price-based margin) |
| Pill: 86 from here | Built | Manager strip; sets the counter to 0 behind manager auth |
| Role filtering | Built | From the clocked-in job: Skip_Table → counter set (bar and cashier share it), else server set; no shift → every pill; Mgr_Menu adds the manager strip |
| Pill: Pairs Well With | Built | Ring-time prompt (Order both / Description / Skip, iOS PairedItemViewController) plus a "Pairs with X" popup pill; off when use_Syphor |
| Pill: pin to favorites | Built | Per-employee pins on this device, on top of Top16; both feed the Favorites tile |
| Pill: make it a combo | Not started | No back-office combo entity; Paul's mockup has a suggested flow to review when this comes up |
| Charity round-up | Parked | Payment screen at settle time: a revenue-neutral service charge (an Adjustment line) that rounds the balance up to the next dollar; sales reports exclude it. Easy, later |
| Customer-attached pills (member price, repeat visit) | Parked | Customer info is available once a customer is attached to the check; leave for now per Geoff |
| Pills blocked on back office or server | Blocked | Upsell, per-item To-Go, audit log, last ordered, allergen data |
