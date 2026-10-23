# Coursing — Technical Spec (cross-platform POS)

Status: draft for Geoff, 2026-10-08. Nothing built yet.

Scope: the iOS course model as ground truth, plus Paul's POS-side proposals
#1, #2, #3, #4, #5, #8, #9, #11. Dropped: #6 KDS-to-POS remote fire, #7
auto-fire via the POS, #10 search-pane batch mode, #12 Bar Command. KDS-only
hold/fire/auto-fire is a KDS feature and is described at the end for the
handshake only.

Hard rule: no iOS changes. Every new field is additive, absent by default, and
when absent every system behaves exactly as it does today.

---

## 1. Ground truth being matched (iOS)

| Piece | iOS | Notes |
|---|---|---|
| Course on a line | `LineItem.print_Sort_Order` "0"–"10" | Sent as `<print_Sort_Order>` on the LineItem, read back on pull-up (FinancialCheckManager :12359, :6590, :15259) |
| Default course | `Menu_Item.Print_Sort_Order` | Applied when the line has none |
| No course | "0" or empty | Prints in the "Others" section |
| Missing entirely | treated as 6 at print time | PrintManager :5404 |
| Show "C{n}" on lines | `Revenue_Center.showCourse` | CheckTableCellView |
| Course bar C1–C10 while ordering | `Revenue_Center.rc_backup21` | Sticky until the check screen is left (courseNum reset in viewWillDisappear) |
| Change course on lines | 1-second long press on a check line → chooser 1–10 and 0, applies to all selected lines | Unsent modifier line → Change Modifier instead; hidden when `Store.use_Syphor` |
| Chit headers | `Store.print_Course_Line`, or every item on the chit has a course | `Printer.useCourse` must be on |
| Header text | `Printer.course1..course10`, default "Course N", centered in asterisks | `Printer.printCourseRed` prints it red |
| Grouping order | course 1..10 then Others; `Revenue_Center.sort_Guest_Before_Course` → guest, then course | |
| KDS | the course name goes to the panel as a type "Co" line before that course's items | Our KDS already groups on "Co" and colors by course name |
| Firing | none; Send fires everything | |

## 2. POS data model

- `CheckLine.course?: number` (0–10). `undefined` = no course chosen; `0` = explicitly none.
- Wire out: emit `<print_Sort_Order>` on Type M lines when `course` is set. Modifiers inherit their parent and emit nothing. This element already exists; the server stores it today.
- Wire in: `parseCheckLines` reads `print_Sort_Order` into `course`.
- Effective course for display and printing: `line.course ?? menuItem.printSortOrder ?? undefined`.
- Catalog: `MenuItem.printSortOrder` from `Print_Sort_Order`.

## 3. Config (all existing columns, read into the catalog)

| Model | Column | Field |
|---|---|---|
| RevenueCenter | `showCourse` | `showCourse` |
| RevenueCenter | `rc_backup21` | `useCourseButtons` |
| RevenueCenter | `sort_Guest_Before_Course` | `guestBeforeCourse` |
| StoreConfig | `print_Course_Line` | `printCourseLine` |
| StoreConfig | `use_Syphor` | `useSyphor` |
| Printer | `useCourse`, `course1..course10`, `printCourseRed` | `useCourse`, `courseNames[10]`, `printCourseRed` |

## 4. Ordering UI

### 4.1 "Adding to" course picker (Paul #1, replaces the iOS C-bar)
- Shown when `rc.useCourseButtons`. Lives on the guest bar next to the guest selector: "Course · Auto ▾" or "Course N ▾".
- Auto = each new item takes its menu item default. Course N = stamp N on every new top-level item. Modifiers never get a stamp.
- Sticky until the check is closed, switched, or the order screen is left, matching iOS `courseNum = -1` on leave.

### 4.2 Course on the check panel (Paul #2, #3, #4, #11; iOS showCourse)
- When `rc.showCourse`, lines are grouped under course headers "COURSE N" in course order, uncoursed items first, trailers (adjustments, references) last. Each header shows pending or sent: sent when any item under it is sent.
- Filter chips above the list: All, C1, C2… built from the courses present. A chip hides other courses. Changing an item's course clears the filter.
- Ten course tints from Paul's hue table, applied to the header and the "C{n}" pill. Style only.
- Sort Guest overrides grouping: when guest sort is on, render flat by guest, no course headers (Paul's bug 1.0bc).
- Without `rc.showCourse`: today's flat list, no pills, no headers.

### 4.3 Change course
- Edit Check gets a "Change Course" action for the selected lines: a 1–10 plus "None" pad. Applies `course` to every selected top-level line; modifiers follow their parent. Hidden when `store.useSyphor`.
- The 1-second long press on a check line (iOS) opens the same pad for that line. A long press on an unsent modifier opens Change Modifier instead, as iOS does. This closes tracker row "Select multiple items and change course".
- Changing the course of a sent line re-posts the line's `print_Sort_Order` with the existing Modify path (`modifyLineItem`, Field_Name `print_Sort_Order`).

### 4.4 Ordering Mode (Paul #8)
- While any unsent top-level items exist: unsent items at the top in entry order, no course grouping, then one pill "N SENT — $X.XX ▼ TAP TO SHOW". Tap expands the full grouped view. Auto-resets after Send.
- Off when `rc.showCourse` is off (nothing to collapse).

### 4.5 Long-press pills (Paul #9)
- The item popup gets a course chip row C1…C10 (only the courses the printers name, plus the item's default highlighted). Tap = ring the item with that course. "Pre-pick course" for bartenders is the same control.

## 5. Printing (iOS rules, no new fields)

- Prep chit per printer: when `printer.useCourse` and (`store.printCourseLine` or every item on this chit has a course), group items under headers in course order, "Others" for 0/none, missing course = 6. Header = `courseNames[n-1] || "Course N"`, centered between asterisks, red when `printCourseRed`.
- `rc.guestBeforeCourse`: group by guest, then course within the guest.
- Closes tracker rows "Courses print on order chits" and "Course override prints properly".
- KDS order JSON: before each course's items, a line `{ type: "Co", description: <course name> }`, exactly as iOS. Our KDS already groups and colors on this.

## 6. Firing (Paul #5, waiter-driven)

Fire is a POS action. Nothing listens for or polls anything.

### 6.1 What Send does
- Printer-routed lines: unchanged. Everything prints at Send with course headers.
- KDS-routed lines, only when the KDS printer definition carries the new `holdUnfiredCourses = "1"` column (see §8): lines whose course is above the lowest unsent course on this round are sent to the KDS with `fired: "0"`. Course 1, and anything with no course, is always `fired: "1"`. Without the column, every line is sent as today (no `fired` key at all).
- Nothing changes on the HBroker check post. The check is the same check.

### 6.2 Fire Course N
- A "FIRE COURSE" button on each course header whose items are sent and not yet fired, and a "Fire course N" entry in the long-press pill set and Edit Check.
- Tapping it, the POS:
  1. Adds a shown Type R reference line `FIRE COURSE N` with a common-schema record `{"type":"firecourse","course":N,"time":"yyyy-MM-dd HH:mm","src":"pos"}` and posts the check (existing R-line mechanism, same as chksplit records). This is the audit trail and the "already fired" state for any terminal that pulls the check up.
  2. Printer stations that hold items of course N: print a small chit "*** FIRE COURSE N ***" listing that course's items for that station, double-wide, red header when `printCourseRed`. No new API; it is a local chit.
  3. KDS stations that hold items of course N: POST a remoteorder document for the same check with `header.fire = "N"` and only that course's lines, each `fired: "1"`. The KDS matches on `checkkey` + `lineitemkey` and flips those lines to live.
- The button is disabled, with "Course N is empty", when no sent item carries that course.
- Fired state on screen: a course is fired when the check has a `firecourse` record for it. Course 1 counts as fired once anything is sent, matching Paul.

### 6.3 What is not here
- No KDS-to-POS path. No POS polling. No background check edits.
- No "Fire Course" menu item in the back office. Paul's build needed one; the R-record replaces it.

## 7. Tests
- Model: course default/override precedence, group ordering, Others/6 rules, guest-before-course, fired-state derivation from records.
- Wire: `print_Sort_Order` round trip, Modify post, R record shape.
- Chit: header text, asterisk centering, red flag, Others section, fire chit.
- KDS JSON: Co lines, `course`/`fired` keys present only when enabled, fire document shape.

---

## 8. API changes needed (all new, all optional, default = today)

No change to the HBroker check wire. No iOS change.

| Where | New field | Who reads it | When absent |
|---|---|---|---|
| Back office → definition sync, `Printer` row (KDS printers) | `holdUnfiredCourses` "0"/"1" | cross-platform POS only; iOS ignores unknown columns | POS sends every KDS line as fired, i.e. current behavior |
| POS → KDS remoteorder JSON, each `lineitem` | `course` ("1"–"10") | cross-platform KDS | KDS keeps grouping on the Co lines as now |
| POS → KDS remoteorder JSON, each `lineitem` | `fired` "0"/"1" | cross-platform KDS | treated as "1" (live), i.e. current behavior |
| POS → KDS remoteorder JSON, `header` | `fire` ("N") | cross-platform KDS | normal order document |

Notes on each:
- `holdUnfiredCourses` is a back-office column add on the Printer definition plus inclusion in the definition feed. Putting it on the printer rather than the revenue center means a site can hold only at the KDS stations that want it. If adding a column is unwelcome, a reserved spare column on Printer would do the same job.
- The three JSON keys ride inside the order blob. The remote-order queue stores and returns the blob untouched, so no pqserver change. The TM-i220 grab-and-print path ignores unknown keys and prints everything at Send, which is why holding must be opt-in per printer.
- The fire record uses the existing Type R / common-schema mechanism the check already uses for chksplit, lixfer, and chkxfer. The server stores it as a normal reference line.

## 9. KDS side (crossplatformkds, separate work)
- Parse `course`, `fired`, and `header.fire`. Unfired lines render in a hold color and do not count toward timers. A `fire` document flips matching lines live and re-sorts them as a new arrival.
- KDS-only remote fire and auto-fire: REMOVED 2026-10-20 (Geoff). The KDS never releases a held course on its own; only the POS fire document does.
- Multi-station note: fire state is per panel. A second panel holding the same order releases only on its own chip, timer, or the POS fire document.
