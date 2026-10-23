/*
 * The open check — client-local order state built as the server taps items.
 * A check is an array of line items (menu items, their modifiers, course
 * markers), mirroring the flat lineitem[] the KDS consumes (model/order.ts in
 * crossplatformkds): each line carries a `type` (M/Mo/Co) and an indent level,
 * modifiers following their parent item. No ORM — plain records, serialized to
 * storage while open and flushed to the kitchen on send (the offline doctrine).
 *
 * Wire serialization (check → send message) lives in protocol/order.ts; this
 * file is the in-memory model + pure reducers only.
 */

import type { MenuItem } from "./catalog";

export type LineKind = "M" | "Mo" | "Co" | "A" | "R"; // menu item · modifier · course marker · adjustment · reference (Type="R")

export interface CheckLine {
  key: string;              // local unique key
  menuItemId: string;       // "" for course markers / adjustments
  description: string;
  quantity: number;
  amount: number;           // unit price (menu item / upcharge modifier); signed for adjustments
  kind: LineKind;
  indentLevel: number;      // 0 = item, 1+ = modifier under an item
  parentKey?: string;       // modifier → the item line it belongs to
  guestNumber?: number;     // Guest_Num — the guest (seat) this line is for; 0 = whole-table/shared
  appliedToGuests?: string; // applied_to_guests — "0" marks a whole-table (T-mode) line
  reference?: string;       // Reference payload (Type="R" lines: text / "NOTSHOWN:…" / JSON)
  modChainId?: string;      // item's forced-modifier chain (Screen_Chain_POS_ID)
  adjustmentId?: string;    // Adjustment_POS_ID (kind "A")
  taxPackId?: string;       // tax pack for a tax-affecting adjustment (kind "A")
  authEmpId?: string;       // AuthorizingEmployee_ID (void / restricted adjustment)
  voidPosId?: string;       // Void_POS_ID (void reason)
  isVoid?: boolean;
  transferOut?: boolean;    // a negative void-off line moving an item off this check (split/transfer)
  isSplit?: boolean;        // Is_Split=1 — a negative marker retiring a line that was divided among guests
  course?: number;          // print_Sort_Order — the line's course (0 = none); undefined = item default
  rungAt?: number;          // ms when this terminal rang the line (local only; drives "Repeat last (12 min ago)")
  held?: boolean;           // Is_Held — on the check but withheld from the kitchen chit
  sent?: boolean;           // already fired to the kitchen in a prior round
  trayNumber?: number;      // Tray_Number the server holds this line under (stamped when sent)
  lineNumber?: number;      // Line_Number within that tray (stamped when sent)
  parentTrayNumber?: number; // Transfered_Out void-off → the ORIGINAL line's Tray_Number (Parent_Tray_Number)
  parentLineNumber?: number; // … and its Line_Number (Parent_LineItem_ID)
}

/** A payment applied to the check — serialized as a Type="T" LineItem on send. */
export interface TenderLine {
  key: string;
  tenderId: string;         // Tender_POS_ID
  name: string;
  amount: number;           // applied to the balance (reduces balance due)
  tip: number;              // Tip_Amount
  change: number;           // Change_Given (cash overpay returned; informational)
  reference?: string;       // room number / auth ref (Reference on the wire)
  balanceRef?: string;      // gift/loyalty remaining balance (Transaction_Ref)
  sent?: boolean;
  trayNumber?: number;      // stamped when posted (void reversals point back here)
  lineNumber?: number;
  isVoid?: boolean;         // struck original, or the negative reversal line
  voidPosId?: string;       // Void_POS_ID (reason) on the reversal
  authEmpId?: string;       // AuthorizingEmployee_ID on the reversal
  parentTrayNumber?: number; // reversal → the ORIGINAL tender's Tray_Number (Void_Parent_Tray_Number)
  parentLineNumber?: number; // … and Line_Number (Void_Line_Item_ID)
}

export interface Check {
  id: string;               // local check id / check_key (uuid-ish)
  revenueCenterId: string;
  tableName: string;        // Check_Name / table label
  diningTableId?: string;   // DiningTable_POS_ID (table-service checks)
  guestCount: number;
  lines: CheckLine[];
  tenders: TenderLine[];
  checkNumber?: string;     // server- or locally-assigned; set on first send
  employeePosId?: string;   // Employee_POS_ID — the check's OWNER (set on read-back / transfer); defaults to the sender
  businessDateId?: string;  // the BusinessDate_ID the server holds this check under (set on read-back) — every re-POST must use it
  traysSent: number;        // service rounds already POSTed (tray numbering)
  closed?: boolean;         // settled + closed (Is_Closed/Is_Settled on the wire)
  exemptTaxGroups?: string[]; // tax report groups removed from this check (Tax_Group_Amt Is_Exempt=1; restored on pull-back like TaxManager removeTaxWithGroupPOS)
  openedAt: number;         // ms
}

const issuedKeys = new Set<string>();
/** A key exactly as the iOS app mints them (FinancialCheckManager.generateCheckKey:
 *  arc4random_uniform(8999999) + 1000000) — a 7-digit NUMERIC string. check_key,
 *  traykey, and lineitemkey are all this shape; the server requires numeric keys.
 *  Guarded so React line keys stay unique within a check. */
export function generateCheckKey(): string {
  for (let i = 0; i < 50; i++) {
    const k = String(Math.floor(Math.random() * 8999999) + 1000000);
    if (!issuedKeys.has(k)) { issuedKeys.add(k); return k; }
  }
  return String(Math.floor(Math.random() * 8999999) + 1000000);
}
/** Unique line/check key. Callers mint it up front so React handlers can
 *  reference the new line before the state updater has run. */
export const mintLineKey = generateCheckKey;

export function newCheck(revenueCenterId: string, tableName = "", guestCount = 1, diningTableId?: string): Check {
  return { id: mintLineKey(), revenueCenterId, tableName, diningTableId, guestCount, lines: [], tenders: [], traysSent: 0, openedAt: Date.now() };
}

/**
 * Resolve where a new line lands from the currently-selected guest, exactly as
 * the iPad does (FinancialCheckManager.m:439-444 et al.):
 *   currentGuest == -1  → whole table ("T" mode): Guest_Num = 1 (the table
 *                          guest; seats excluded on Android) + applied_to_guests="0"
 *   otherwise           → Guest_Num = currentGuest + 1  (guest 1..N)
 * `currentGuest` is a 0-based index (0 = guest 1); -1 is the T (whole-table) tile.
 */
export function guestAssignment(currentGuest: number): { guestNumber: number; appliedToGuests?: string } {
  if (currentGuest === -1) return { guestNumber: 1, appliedToGuests: "0" };
  return { guestNumber: currentGuest + 1 };
}

/** Append a menu item as a new order line (quantity 1) with the caller's key. */
export function addItemLine(check: Check, item: MenuItem, key: string, guestNumber?: number, appliedToGuests?: string, course?: number, held?: boolean): Check {
  const line: CheckLine = {
    key, menuItemId: item.id, description: item.name,
    quantity: 1, amount: Number(item.price) || 0, kind: "M", indentLevel: 0,
    modChainId: item.modChainId || undefined, guestNumber, appliedToGuests, course, held: held || undefined,
    rungAt: Date.now(),
  };
  return { ...check, lines: [...check.lines, line] };
}

/** Insert a modifier line directly beneath its parent item (and any siblings).
 *  A modifier inherits its parent's guest so it sorts and moves with the item. */
export function addModifierLine(
  check: Check, parentKey: string, item: MenuItem, amount: number, indentLevel = 1,
): Check {
  const parent = check.lines.find((l) => l.key === parentKey);
  const line: CheckLine = {
    key: mintLineKey(), menuItemId: item.id, description: item.name,
    quantity: 1, amount, kind: "Mo", indentLevel, parentKey,
    guestNumber: parent?.guestNumber, appliedToGuests: parent?.appliedToGuests,
  };
  const lines = [...check.lines];
  // place after the parent and its existing descendants
  let idx = lines.findIndex((l) => l.key === parentKey);
  if (idx < 0) return { ...check, lines: [...lines, line] };
  idx++;
  while (idx < lines.length && lines[idx].parentKey === parentKey) idx++;
  lines.splice(idx, 0, line);
  return { ...check, lines };
}

/** Remove a line and any modifiers hanging off it (unsent lines only). */
/** iPad idle timeout (CheckViewController idleTimerExceeded :10381-10420): every unsent
 *  line goes — menu items with their modifiers, and adjustments — EXCEPT unsent gift-card
 *  sale / reload items, which stay. `keepCheck` says whether anything is left worth keeping
 *  (a sent line, or a kept gift-card line); otherwise the check is dropped. */
export function sweepUnsentForIdle(check: Check, gcItemIds: string[]): { check: Check; keepCheck: boolean } {
  const gc = new Set(gcItemIds.filter(Boolean));
  const drop = new Set<string>();
  for (const l of check.lines) {
    if (l.sent) continue;
    if (l.kind === "M" && gc.has(l.menuItemId)) continue;
    if (l.kind === "M" || l.kind === "A") drop.add(l.key);
  }
  const lines = check.lines.filter((l) => !drop.has(l.key) && !(l.parentKey && drop.has(l.parentKey)));
  const keepCheck = lines.some((l) => l.sent || (l.kind === "M" && gc.has(l.menuItemId)));
  return { check: { ...check, lines }, keepCheck };
}

export function removeLine(check: Check, key: string): Check {
  return { ...check, lines: check.lines.filter((l) => l.key !== key && l.parentKey !== key) };
}

/** Change an unsent item's quantity. Its modifiers follow (updateQuantityForLineItems
 *  scales the whole family), so a priced modifier extends with the parent. */
export function setQuantity(check: Check, key: string, quantity: number): Check {
  if (quantity <= 0) return removeLine(check, key);
  return { ...check, lines: check.lines.map((l) => (l.key === key || l.parentKey === key ? { ...l, quantity } : l)) };
}

/** A line's extended price (unit × qty). Modifiers may carry an upcharge. */
export const lineExtended = (l: CheckLine): number => (l.isVoid ? 0 : l.amount * l.quantity);

/** Running subtotal across current lines — items + adjustments (discounts are
 *  negative), excluding void/void-off lines. */
export const checkSubtotal = (check: Check): number =>
  check.lines.reduce((sum, l) => sum + (l.transferOut || l.isVoid || l.isSplit ? 0 : lineExtended(l)), 0);

/** Append an adjustment (discount/comp/service charge) as a Type="A" line.
 *  `amount` is the signed extended dollar amount (discounts negative). */
export function addAdjustmentLine(check: Check, a: {
  adjustmentId: string; name: string; amount: number; taxPackId?: string; authEmpId?: string;
  parentKey?: string; guestNumber?: number; appliedToGuests?: string;
}): Check {
  const line: CheckLine = {
    key: mintLineKey(), menuItemId: "", description: a.name, quantity: 1, amount: a.amount,
    kind: "A", indentLevel: a.parentKey ? 1 : 0, adjustmentId: a.adjustmentId, taxPackId: a.taxPackId, authEmpId: a.authEmpId,
    parentKey: a.parentKey, guestNumber: a.guestNumber, appliedToGuests: a.appliedToGuests,
  };
  if (!a.parentKey) return { ...check, lines: [...check.lines, line] };
  // an item-level adjustment sits right under its item (after the item's modifiers)
  const lines = [...check.lines];
  let idx = lines.findIndex((l) => l.key === a.parentKey);
  if (idx < 0) return { ...check, lines: [...lines, line] };
  idx++;
  while (idx < lines.length && lines[idx].parentKey === a.parentKey) idx++;
  lines.splice(idx, 0, line);
  return { ...check, lines };
}

/** Live (unsent or sent, not voided) lines — what discounts and gratuities see. */
const isLive = (l: CheckLine) => !l.isVoid && !l.transferOut && !l.isSplit;

/** Sum of the existing discounts hanging off an item (negative), the iPad's
 *  getDiscountTotalForLineItem — later discounts apply to the NET amount. */
export const itemDiscountTotal = (check: Check, itemKey: string): number =>
  check.lines.filter((l) => l.kind === "A" && l.parentKey === itemKey && isLive(l) && l.amount < 0).reduce((s, l) => s + l.amount, 0);

export interface AdjDef { id: string; name: string; isPercentage: boolean; isServiceCharge: boolean; taxPackId?: string; affectsTaxes: boolean; }

/**
 * Item-level adjustment (FinancialCheckManager addAdjustmentsToLineItems: :3890-4020):
 * one Type="A" line per eligible item, linked by Parent_LineItem_ID, carrying the
 * item's guest. Discounts work on the item NET of earlier discounts:
 *   percentage → magnitude% × (base + already)
 *   fixed      → magnitude × (base + already) / totalBase, the LAST item taking the
 *                remainder so the pieces sum to the entered amount
 * and are capped at the net amount (never discount below zero). Service charges
 * use the gross base. Zero pieces are skipped. `magnitude` is the percent or the
 * dollar amount (open adjustments pass the operator's entry).
 */
export function applyItemAdjustments(check: Check, adj: AdjDef, magnitude: number, itemKeys: string[], authEmpId = ""): Check {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const items = itemKeys.map((k) => check.lines.find((l) => l.key === k)).filter((l): l is CheckLine => !!l && l.kind === "M" && isLive(l));
  if (items.length === 0) return check;
  const nets = items.map((it) => lineExtended(it) + (adj.isServiceCharge ? 0 : itemDiscountTotal(check, it.key)));
  const totalBase = nets.reduce((s, n) => s + n, 0);
  let left = magnitude;
  let out = check;
  items.forEach((it, i) => {
    const net = nets[i];
    let piece: number;
    if (adj.isPercentage) piece = r2(magnitude * net * 0.01);
    else if (i === items.length - 1) piece = r2(left);
    else { piece = totalBase ? r2(magnitude * net / totalBase) : 0; left = r2(left - piece); }
    if (!adj.isServiceCharge && Math.abs(piece) > Math.abs(net)) piece = r2(Math.max(0, net));
    if (piece === 0) return;
    out = addAdjustmentLine(out, {
      adjustmentId: adj.id, name: adj.name, amount: adj.isServiceCharge ? Math.abs(piece) : -Math.abs(piece),
      taxPackId: adj.affectsTaxes ? adj.taxPackId || undefined : undefined, authEmpId,
      parentKey: it.key, guestNumber: it.guestNumber, appliedToGuests: it.appliedToGuests,
    });
  });
  return out;
}

export interface AutoGratDef extends AdjDef { partySize: number; amount: number; departmentOk: (l: CheckLine) => boolean; }

/**
 * Automatic gratuity (generateCheckServiceChargeForCheck:withLineItems:): for every
 * automatic percentage service charge whose Party_Size the check meets, ONE charge
 * line per guest = that guest's live menu-item total (department-eligible) × Amount%.
 * A guest already carrying the same charge at the same amount is left alone; a
 * stale unsent charge is replaced, a stale SENT one is voided and re-added. Guests
 * with no items get nothing.
 */
export function applyAutoGratuity(check: Check, defs: AutoGratDef[], authEmpId = ""): Check {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const guests = Math.max(1, check.guestCount);
  let out = check;
  for (const adj of defs) {
    if (!adj.isServiceCharge || !adj.isPercentage || adj.amount <= 0 || guests < adj.partySize) continue;
    for (let g = 1; g <= Math.min(guests, 25); g++) {
      const total = out.lines
        .filter((l) => l.kind === "M" && isLive(l) && (l.guestNumber ?? 1) === g && adj.departmentOk(l))
        .reduce((s, l) => s + lineExtended(l), 0);
      const want = total > 0.005 ? r2(total * adj.amount * 0.01) : 0;
      const existing = out.lines.filter((l) => l.kind === "A" && l.adjustmentId === adj.id && isLive(l) && (l.guestNumber ?? 1) === g);
      if (existing.length && Math.abs(existing.reduce((s, l) => s + l.amount, 0) - want) < 0.005) continue; // already right
      for (const e of existing) out = e.sent ? voidLine(out, e.key, "", authEmpId) : removeLine(out, e.key);
      if (want > 0.005) out = addAdjustmentLine(out, {
        adjustmentId: adj.id, name: adj.name, amount: want, taxPackId: adj.affectsTaxes ? adj.taxPackId || undefined : undefined,
        authEmpId, guestNumber: g,
      });
    }
  }
  return out;
}

/** Override a menu line's unit price (Change Price — unsent menu items only). */
export function setLinePrice(check: Check, key: string, amount: number): Check {
  return { ...check, lines: check.lines.map((l) => (l.key === key && !l.sent && l.kind === "M" ? { ...l, amount } : l)) };
}

/** Re-order (Last Round): append fresh unsent copies of the selected *sent*
 *  menu items (and their modifiers) so the next send fires them again as a new
 *  round — i.e. "order the same thing again". FinancialCheckManager reorderItems. */
export function reorderLines(check: Check, keys: Set<string>): Check {
  const selected = new Set<string>();
  for (const l of check.lines) if (keys.has(l.key) || (l.parentKey && selected.has(l.parentKey))) selected.add(l.key);
  const keyMap = new Map<string, string>();
  const copies: CheckLine[] = [];
  for (const l of check.lines) {
    if (!selected.has(l.key) || !l.sent || l.isVoid || l.transferOut) continue;
    if (l.kind !== "M" && l.kind !== "Mo") continue; // re-fire menu items + their modifiers only
    const nk = mintLineKey();
    keyMap.set(l.key, nk);
    copies.push({ ...l, key: nk, sent: false, parentKey: l.parentKey ? keyMap.get(l.parentKey) : undefined });
  }
  return { ...check, lines: [...check.lines, ...copies] };
}

/** Hold / unhold the selected item families (FinancialCheckManager holdUnHoldItems
 *  :1643-1790). An UNSENT line just toggles Is_Held. Unholding a SENT held line
 *  re-fires it the iPad way: the original leaves via a Transfered_Out void-off
 *  (negative, hidden, Parent_* → the original so pull-back nets it) and a fresh
 *  unheld copy — same guest / whole-table flag — is appended for the next send.
 *  Sent, not-held lines are left alone (already fired). */
export function holdUnholdLines(check: Check, keys: Set<string>): Check {
  const fam = new Set<string>();
  for (const l of check.lines) if (keys.has(l.key) || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
  const out: CheckLine[] = [];
  const keyMap = new Map<string, string>();
  const recreated: CheckLine[] = [];
  for (const l of check.lines) {
    const eligible = fam.has(l.key) && (l.kind === "M" || l.kind === "Mo" || l.kind === "A") && !l.isVoid && !l.transferOut;
    if (!eligible) { out.push(l); continue; }
    if (!l.sent) { out.push({ ...l, held: !l.held }); continue; }
    if (!l.held) { out.push(l); continue; }
    // sent + held → unhold: void-off replaces the original, fresh copy re-fires
    out.push({
      ...l, key: mintLineKey(), amount: -Math.abs(l.amount), transferOut: true, isVoid: false, sent: false, held: false,
      parentKey: undefined, parentTrayNumber: l.trayNumber, parentLineNumber: l.lineNumber, trayNumber: undefined, lineNumber: undefined,
    });
    const nk = mintLineKey(); keyMap.set(l.key, nk);
    recreated.push({ ...l, key: nk, sent: false, held: false, parentKey: l.parentKey ? keyMap.get(l.parentKey) : undefined, trayNumber: undefined, lineNumber: undefined });
  }
  return { ...check, lines: [...out, ...recreated] };
}

/** Void an item family (the line + its modifiers — voidLineItems voids the family).
 *  Unsent lines are dropped; each SENT line is struck and gets a reversing negative
 *  Is_Void line that names the original via Void_Line_Item_ID / Void_Parent_Tray_Number
 *  (:1957-1958) so the server and every pull-back cancel it. */
export function voidLine(check: Check, key: string, voidPosId: string, authEmpId: string): Check {
  const fam = new Set<string>();
  for (const l of check.lines) if (l.key === key || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
  if (fam.size === 0) return check;
  const out: CheckLine[] = [];
  const reversals: CheckLine[] = [];
  for (const l of check.lines) {
    if (!fam.has(l.key)) { out.push(l); continue; }
    if (!l.sent) continue;                                   // never reached the server
    out.push({ ...l, isVoid: true });                         // struck original (hidden/shown per showVoids)
    reversals.push({
      ...l, key: mintLineKey(), amount: -Math.abs(l.amount), isVoid: true, sent: false, held: false,
      voidPosId, authEmpId, parentKey: undefined,
      parentTrayNumber: l.trayNumber, parentLineNumber: l.lineNumber, trayNumber: undefined, lineNumber: undefined,
    });
  }
  return { ...check, lines: [...out, ...reversals] };
}

/** Total applied by tenders so far (change is not applied; it's returned cash). */
export const tenderApplied = (check: Check): number =>
  check.tenders.filter((t) => !t.isVoid).reduce((sum, t) => sum + t.amount, 0); // struck originals and their reversals net out

/** Balance still owed (subtotal − tenders applied). Tax deferred; see above. */
export const balanceDue = (check: Check): number =>
  Math.max(0, round2(checkSubtotal(check) - tenderApplied(check)));

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const isPaid = (check: Check): boolean =>
  check.lines.length > 0 && balanceDue(check) <= 0.005;

/** Append a tender (payment) to the check. */
export function addTender(check: Check, t: Omit<TenderLine, "key">): Check {
  return { ...check, tenders: [...check.tenders, { ...t, key: mintLineKey() }] };
}

/**
 * Void a tender (iOS voidLineItem on a Type T line, FinancialCheckManager :9893+):
 * an unsent one is simply removed; a POSTED one is struck and a negative
 * reversal (amount and tip negated, Is_Void, Void_Line_Item_ID → original)
 * goes out on the next post. Cash and offline cards alike.
 */
export function voidTenderLine(check: Check, key: string, voidPosId: string, authEmpId: string): Check {
  const t = check.tenders.find((x) => x.key === key);
  if (!t || t.isVoid) return check;
  if (!t.sent) return removeTender(check, key);
  const reversal: TenderLine = {
    ...t, key: mintLineKey(), amount: -Math.abs(t.amount), tip: -Math.abs(t.tip || 0), change: 0,
    isVoid: true, sent: false, voidPosId, authEmpId,
    parentTrayNumber: t.trayNumber, parentLineNumber: t.lineNumber, trayNumber: undefined, lineNumber: undefined,
  };
  return { ...check, tenders: [...check.tenders.map((x) => (x.key === key ? { ...x, isVoid: true } : x)), reversal] };
}

export function removeTender(check: Check, key: string): Check {
  return { ...check, tenders: check.tenders.filter((t) => t.key !== key || t.sent === true) }; // only an UNSENT tender can be removed; sent ones stay
}

/** Lines not yet fired to the kitchen — the "new round" a send transmits. */
export const unsentLines = (check: Check): CheckLine[] => check.lines.filter((l) => !l.sent);
export const unsentTenders = (check: Check): TenderLine[] => check.tenders.filter((t) => !t.sent);

/**
 * Split Item — move the selected item families onto a brand-new check on the same
 * table/tab (CheckViewController didSelectTableNewCheck :20128-20168 path): guests
 * renumber 1..k and the new check's Guest_Count is the number of guests that moved
 * (min 1), NOT the source's count. Runs on moveLines (Transfered_Out void-offs on
 * the source, chksplit records on the new check).
 */
export function splitToNewCheck(source: Check, keys: Set<string>, o: { authEmpId?: string; now?: Date } = {}): { source: Check; dest: Check } {
  const fam = expandFamilies(source.lines, keys);
  const gs = [...new Set(source.lines.filter((l) => fam.has(l.key)).map((l) => l.guestNumber ?? 0).filter((g) => g > 0 && g <= 90))].sort((a, b) => a - b);
  const dest0 = newCheck(source.revenueCenterId, source.tableName, Math.max(1, gs.length), source.diningTableId);
  const srcNo = source.checkNumber ?? "";
  const r = moveLines(source, dest0, keys, { kind: "chksplit", srcCheckNo: srcNo, authEmpId: o.authEmpId, now: o.now, guestMap: new Map(gs.map((g, i) => [g, i + 1])) });
  return { source: r.source, dest: addSplitCheckRecord(r.dest, srcNo, o.authEmpId ?? "", o.now) };
}

/* ---- Type="R" reference lines (FinancialCheckManager.m:18649-18774, 21856-21883) ----
 * A reference line is a non-priced metadata/audit row (Type="R"). Four flavours,
 * the shared substrate for guest notes, splits, transfers, merges, and misc audit:
 *   - shown text      → addShownRef            (plain Reference, renders on the check)
 *   - shown per-guest → addGuestNote           (Reference + Guest_Num, renders)
 *   - machine record  → addNotShownRef         (Reference "NOTSHOWN:…", hidden)
 *   - structured audit→ addCommonSchemaRef      (Reference JSON + AuthorizingEmployee_ID, hidden)
 */
export const NOTSHOWN_PREFIX = "NOTSHOWN:";

function newRefLine(reference: string, extra: Partial<CheckLine> = {}): CheckLine {
  return {
    key: mintLineKey(), menuItemId: "", description: "", quantity: 1, amount: 0,
    kind: "R", indentLevel: 0, reference, ...extra,
  };
}

/** A plain human-readable note that shows on the check (addShownReferenceItem). */
export function addShownRef(check: Check, text: string): Check {
  return { ...check, lines: [...check.lines, newRefLine(text)] };
}

/** A shown note tied to a specific guest (addReferenceLineItem:Guest:). */
export function addGuestNote(check: Check, guestNumber: number, text: string): Check {
  return { ...check, lines: [...check.lines, newRefLine(text, { guestNumber })] };
}

/** A machine-only record, hidden from the check (addNotShownReferenceItem).
 *  `ref` is the payload after the "NOTSHOWN:" prefix, e.g. "GuestCount::4". */
export function addNotShownRef(check: Check, ref: string): Check {
  return { ...check, lines: [...check.lines, newRefLine(NOTSHOWN_PREFIX + ref)] };
}

/** A structured audit record, hidden from the check (addCommonSchemaReferenceLineItem).
 *  Reference is JSON ({"type":…}); it stamps AuthorizingEmployee_ID. */
export function addCommonSchemaRef(check: Check, payload: object, authEmpId: string): Check {
  return { ...check, lines: [...check.lines, newRefLine(JSON.stringify(payload), { authEmpId })] };
}

/** Does this reference line render on the check display? Mirrors the iPad filter
 *  (FinancialCheckManager.m:16752-16754): a ref is HIDDEN when it carries any of
 *  Adjustment_POS_ID / applied_to_guests / AuthorizingEmployee_ID, has no
 *  Reference, or the Reference contains "NOTSHOWN". Everything else shows. */
export function refIsShown(l: CheckLine): boolean {
  if (l.kind !== "R" || l.isVoid) return false;
  if (!l.reference) return false;
  if (l.reference.includes("NOTSHOWN")) return false;
  if (l.authEmpId !== undefined || l.appliedToGuests || l.adjustmentId) return false;
  return true;
}

/* ---------------- Coursing (print_Sort_Order) ---------------- */

/** The course a line prints under: its own override, else the item's default
 *  (CheckTableViewController :231-237 / PrintManager :5404). 0 = none. */
export function effectiveCourse(line: CheckLine, itemDefault: number): number {
  if (line.course !== undefined) return line.course;
  return itemDefault > 0 ? itemDefault : 0;
}

/** Set the course on the selected top-level lines (CouringViewController pressN /
 *  pressZero). Modifiers follow their parent and never carry one themselves. */
export function setCourse(check: Check, keys: Set<string>, course: number): Check {
  return { ...check, lines: check.lines.map((l) => (keys.has(l.key) && l.kind === "M" ? { ...l, course } : l)) };
}

/** Fire now: the posted subset's stamped lines (sent + tray/line numbers) replace
 *  their originals; the other lines, including still-unsent ones, are untouched. */
export function absorbSentLines(check: Check, stamped: Check, keys: Set<string>): Check {
  const byKey = new Map(stamped.lines.filter((l) => keys.has(l.key)).map((l) => [l.key, l]));
  return {
    ...check,
    checkNumber: stamped.checkNumber ?? check.checkNumber,
    traysSent: Math.max(check.traysSent, stamped.traysSent),
    lines: check.lines.map((l) => byKey.get(l.key) ?? l),
  };
}

/** The latest live line of a menu item on the check (Repeat last pill). */
export function lastLineOf(check: Check, menuItemId: string): CheckLine | undefined {
  for (let i = check.lines.length - 1; i >= 0; i--) {
    const l = check.lines[i];
    if (l.kind === "M" && l.menuItemId === menuItemId && !l.isVoid && !l.transferOut && !l.isSplit) return l;
  }
  return undefined;
}

/** Repeat last: ring the item again exactly as its latest line — same mods,
 *  seat, course and reference — as a fresh unsent family. */
export function repeatLastOf(check: Check, menuItemId: string, now = Date.now()): { check: Check; key?: string } {
  const last = lastLineOf(check, menuItemId);
  if (!last) return { check };
  const key = mintLineKey();
  const strip = (l: CheckLine): CheckLine => {
    const c = { ...l, sent: undefined, trayNumber: undefined, lineNumber: undefined, held: undefined, rungAt: now };
    delete c.sent; delete c.trayNumber; delete c.lineNumber; delete c.held;
    return c;
  };
  const copies: CheckLine[] = [{ ...strip(last), key }];
  for (const l of check.lines) if (l.parentKey === last.key && l.kind === "Mo" && !l.isVoid) copies.push({ ...strip(l), key: mintLineKey(), parentKey: key });
  return { check: { ...check, lines: [...check.lines, ...copies] }, key };
}

/** A note on a menu-item line (Reference on the M LineItem — iOS emits Reference
 *  on any line that has one; prints under the item on the chit). */
export function setLineReference(check: Check, key: string, text: string): Check {
  const t = text.trim();
  return { ...check, lines: check.lines.map((l) => (l.key === key ? { ...l, reference: t || undefined } : l)) };
}

/** Change Revenue Center on a check that already has lines (CheckViewController
 *  ChangeRVC → FinancialCheckManager addChangeRVCReference): the RC changes and a
 *  hidden {"type":"ChangeRVC"} record goes out with the next post. */
export function changeRevenueCenter(check: Check, to: { id: string; name: string }, fromName: string, empId: string, authEmpId = "", now?: Date): Check {
  if (check.revenueCenterId === to.id) return check;
  const next = { ...check, revenueCenterId: to.id };
  return addCommonSchemaRef(next, { type: "ChangeRVC", chk: asNum(check.checkNumber ?? ""), oldRVC: fromName, newRVC: to.name, emp: asNum(empId), time: stampNoSec(now) }, authEmpId);
}

/** Fire Course N: a SHOWN "FIRE COURSE N" note plus the hidden audit record
 *  {"type":"firecourse"} — the fired state any terminal can read back. */
export function addFireCourseRecord(check: Check, course: number, authEmpId = "", now?: Date): Check {
  const noted = addShownRef(check, `FIRE COURSE ${course}`);
  return addCommonSchemaRef(noted, { type: "firecourse", course, time: stampNoSec(now), src: "pos" }, authEmpId);
}

/** Courses already fired on this check (from the firecourse records). */
export function firedCourses(check: Check): Set<number> {
  const out = new Set<number>();
  for (const l of check.lines) {
    if (l.kind !== "R" || l.isVoid || !l.reference || !l.reference.startsWith("{")) continue;
    try {
      const rec = JSON.parse(l.reference) as { type?: string; course?: number | string };
      if (rec.type === "firecourse" && rec.course !== undefined) out.add(Number(rec.course));
    } catch { /* not a record */ }
  }
  return out;
}

/** Reassign a line's guest (change-guest). Guest 0 sets only applied_to_guests="0"
 *  (whole-table), leaving Guest_Num; otherwise sets Guest_Num and clears the
 *  whole-table marker (updateGuestForLineItems:guestNumber: :11416-11454). */
export function setLineGuest(check: Check, keys: Set<string>, guestNumber: number): Check {
  // include modifiers hanging off a selected parent
  const fam = new Set<string>();
  for (const l of check.lines) if (keys.has(l.key) || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
  return {
    ...check,
    lines: check.lines.map((l) => {
      if (!fam.has(l.key)) return l;
      return guestNumber === 0
        ? { ...l, appliedToGuests: "0" }
        : { ...l, guestNumber, appliedToGuests: undefined };
    }),
  };
}

/** Number of guest avatars to render — max of the guest count and any guest a
 *  line already references (getHighestGuestNumber :24567-24589). Reserved bands
 *  (>=50) are not real seats and are ignored. */
export function highestGuestNumber(check: Check): number {
  let hi = check.guestCount;
  for (const l of check.lines) {
    const g = l.guestNumber ?? 0;
    if (g > hi && g < 50) hi = g;
  }
  return Math.max(1, hi);
}

/** Display order grouped by guest (compareLineItemsByGuest :312-348): guests
 *  ascending, whole-table (Guest_Num 0) first, each item keeping its modifiers.
 *  Pure/stable — a view sort, it does not mutate the check. */
export function sortLinesByGuest(lines: CheckLine[]): CheckLine[] {
  // Build item families (an item plus the modifiers that follow it) in order.
  const families: CheckLine[][] = [];
  const byKey = new Map<string, CheckLine[]>();
  for (const l of lines) {
    if (l.parentKey && byKey.has(l.parentKey)) { byKey.get(l.parentKey)!.push(l); continue; }
    const fam = [l];
    families.push(fam);
    byKey.set(l.key, fam);
  }
  const guestOf = (fam: CheckLine[]) => fam[0].guestNumber ?? 0;
  return families
    .map((fam, i) => ({ fam, i }))
    .sort((a, b) => guestOf(a.fam) - guestOf(b.fam) || a.i - b.i) // stable within a guest
    .flatMap((x) => x.fam);
}

/* ---- Moving lines between checks (the shared core for Split Guest / Transfer
 * Item / Merge). Faithful to FinancialCheckManager.m:
 *   dest copies   addnewLineItems:WithGuests:AfterGuest:fromCheck: (:10598-10700)
 *                 and addSplitCheckNewLineItems (:10500-10590): positive copies,
 *                 AuthorizingEmployee_ID stamped, Guest_Num remapped (0 / >90 kept),
 *                 parent links remapped, and per line a common-schema R record
 *                 {"type":"lixfer"|"chksplit","tray","li","mi","qt","time","src"}.
 *   source        voidLineItems under isTransferItems (:1946-1952): a NEGATIVE
 *                 line, Transfered_Out=1, Is_Void=0, Show/Print=0, Parent_* → the
 *                 original line. Unsent originals are simply dropped.
 */
export type MoveKind = "lixfer" | "chksplit";
export interface MoveOpts {
  kind: MoveKind;
  srcCheckNo: string;              // "src" in the record — the check the lines left
  authEmpId?: string;              // AuthorizingEmployee_ID on the copies / records / void-offs
  guestMap?: Map<number, number>;  // old Guest_Num → new (compacting for a split)
  guestOffset?: number;            // added after the map (landing on an existing check)
  now?: Date;
}

/** "yyyy-MM-dd HH:mm" — noSecDateFormatter, the timestamp inside every record. */
export function stampNoSec(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const asNum = (s: string): number | string => (/^\d+$/.test(s) ? Number(s) : s);

/** Expand a selection to include the modifiers hanging off each selected parent. */
function expandFamilies(lines: CheckLine[], keys: Set<string>): Set<string> {
  const fam = new Set<string>();
  for (const l of lines) if (keys.has(l.key) || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
  return fam;
}

export function moveLines(source: Check, dest: Check, keys: Set<string>, o: MoveOpts): { source: Check; dest: Check } {
  const fam = expandFamilies(source.lines, keys);
  const time = stampNoSec(o.now);
  const src = asNum(o.srcCheckNo);
  const remapGuest = (g?: number): number | undefined => {
    if (g === undefined) return undefined;
    if (g === 0 || g > 90) return g;                       // whole-table / reserved bands ride as-is
    return (o.guestMap?.get(g) ?? g) + (o.guestOffset ?? 0);
  };

  // Destination: positive copies + one record per copy. Line_Number is what the
  // wire will assign (unsent lines in order), tray is the next round.
  const tray = dest.traysSent + 1;
  let li = dest.lines.filter((l) => !l.sent).length;
  const keyMap = new Map<string, string>();
  const destLines = [...dest.lines];
  for (const l of source.lines) {
    if (!fam.has(l.key)) continue;
    const nk = mintLineKey();
    keyMap.set(l.key, nk);
    destLines.push({
      ...l, key: nk, sent: false, transferOut: false, isVoid: false,
      authEmpId: o.authEmpId ?? l.authEmpId,
      guestNumber: remapGuest(l.guestNumber),
      parentKey: l.parentKey ? keyMap.get(l.parentKey) : undefined,
      trayNumber: undefined, lineNumber: undefined, parentTrayNumber: undefined, parentLineNumber: undefined,
    });
    li++;
    const rec = { type: o.kind, tray, li, mi: l.description, qt: l.quantity, time, src };
    destLines.push(newRefLine(JSON.stringify(rec), { authEmpId: o.authEmpId ?? "" }));
    li++;
  }

  // Source: sent originals become Transfered_Out void-offs; unsent ones vanish.
  const srcLines: CheckLine[] = [];
  for (const l of source.lines) {
    if (!fam.has(l.key)) { srcLines.push(l); continue; }
    if (!l.sent) continue;
    srcLines.push({
      ...l, key: mintLineKey(), amount: -Math.abs(l.amount), transferOut: true, isVoid: false, sent: false, held: false,
      parentKey: undefined, authEmpId: o.authEmpId ?? l.authEmpId,
      parentTrayNumber: l.trayNumber, parentLineNumber: l.lineNumber,
      trayNumber: undefined, lineNumber: undefined,
    });
  }
  return { source: { ...source, lines: srcLines }, dest: { ...dest, lines: destLines } };
}

/** Does the check still carry a live priced item? Split Guest / Transfer Item
 *  close the source (Is_Closed=1) only when this is false. */
export const hasLiveItems = (check: Check): boolean =>
  check.lines.some((l) => l.kind === "M" && !l.isVoid && !l.transferOut && !l.isSplit);

/**
 * Split Item — divide the selected item families evenly among `guests`
 * (FinancialCheckManager splitItemsForGuests:guests: :11706-11940). Each guest
 * gets a portion line: Quantity/n and Amount/n rounded to cents, the LAST guest
 * taking the remainder so the portions sum exactly; modifiers follow their
 * parent's portion. The original is retired: unsent → deleted, sent → a negative
 * Is_Split=1 marker with Parent_* → the original (so pull-back drops it).
 */
export function splitItemAmongGuests(check: Check, keys: Set<string>, guests: number[], authEmpId = ""): Check {
  const n = guests.length;
  if (n < 2) return check;
  const fam = expandFamilies(check.lines, keys);
  const out: CheckLine[] = [];
  const portions: CheckLine[] = [];
  const markers: CheckLine[] = [];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // parent key map per guest so a modifier portion hangs off its parent's portion
  const keyMaps = guests.map(() => new Map<string, string>());
  for (const l of check.lines) {
    if (!fam.has(l.key)) { out.push(l); continue; }
    const ext = r2(l.amount * l.quantity);
    const qEach = r2(l.quantity / n), aEach = r2(ext / n);
    guests.forEach((g, j) => {
      const last = j === n - 1;
      const qty = last ? r2(l.quantity - qEach * (n - 1)) : qEach;
      const amt = last ? r2(ext - aEach * (n - 1)) : aEach;
      const nk = mintLineKey(); keyMaps[j].set(l.key, nk);
      portions.push({
        ...l, key: nk, quantity: qty, amount: qty ? amt / qty : amt, guestNumber: g, appliedToGuests: undefined,
        sent: false, held: false, isVoid: false, transferOut: false, isSplit: false, authEmpId: authEmpId || l.authEmpId,
        parentKey: l.parentKey ? keyMaps[j].get(l.parentKey) : undefined, trayNumber: undefined, lineNumber: undefined,
      });
    });
    if (l.sent) markers.push({
      ...l, key: mintLineKey(), amount: -Math.abs(l.amount), isSplit: true, isVoid: false, transferOut: false, sent: false, held: false,
      authEmpId: authEmpId || l.authEmpId, parentKey: undefined,
      parentTrayNumber: l.trayNumber, parentLineNumber: l.lineNumber, trayNumber: undefined, lineNumber: undefined,
    });
  }
  return { ...check, lines: [...out, ...portions, ...markers] };
}

/** Check-level split marker on the NEW check (addSplitCheckLineItemFromCheck :18380-18391) —
 *  what isSplitCheck: later recognises. */
export function addSplitCheckRecord(dest: Check, srcCheckNo: string, authEmpId = "", now?: Date): Check {
  return addCommonSchemaRef(dest, { type: "chksplit", time: stampNoSec(now), src: asNum(srcCheckNo) }, authEmpId);
}

/** Whole-check transfer to another employee (addTransferLineItem :18316-18377):
 *  a SHOWN "Xfer from A  to  B" note plus the chkxfer audit record. The new owner
 *  rides as the FinancialCheck's Employee_POS_ID on the re-POST. */
export function addTransferCheckRecord(
  check: Check, from: { id: string; name: string }, to: { id: string; name: string }, authEmpId = "", now?: Date,
): Check {
  const noted = addShownRef(check, `Xfer from ${from.name || from.id}  to  ${to.name || to.id}`);
  return addCommonSchemaRef(noted, { type: "chkxfer", fromempid: asNum(from.id), toempid: asNum(to.id), time: stampNoSec(now) }, authEmpId);
}

/** Merge marker on the SOURCE check (CheckViewController.m:19692 "CheckMerge:fromCheck:toCheck:AuthEmp"). */
export function addMergeRecord(source: Check, fromCheckNo: string, toCheckNo: string, authName = " "): Check {
  return addShownRef(source, `CheckMerge:${fromCheckNo}:${toCheckNo}:${authName || " "}`);
}

/** One destination of a split/transfer plan (a Split Check screen column). */
export interface MoveTarget {
  kind: "new" | "existing"; name: string; dest?: Check; keys: Set<string>;
  tableId?: string | null;             // new check: undefined = same table/tab as source · null = a tab · id = that table
}
export interface MovePlanOpts {
  moveKind: MoveKind; srcCheckNo: string; authEmpId?: string; now?: Date;
  newCheck: (name: string, target: MoveTarget) => Check;   // mints the destination for a "new" target (number, table, RC, owner)
}

/**
 * Run a whole plan through moveLines, target by target, threading the shrinking
 * source. Guests compact to 1..k on each destination (the iPad's `guests` map)
 * and land after an existing check's own guests (AfterGuest offset); a new check
 * spawned by Split Guest also gets the check-level chksplit marker. Reports
 * whether the source is now empty so the caller closes it (Is_Closed=1).
 */
export function applyMovePlan(source: Check, targets: MoveTarget[], o: MovePlanOpts): { source: Check; dests: { target: MoveTarget; dest: Check }[]; closeSource: boolean } {
  let src = source;
  const dests: { target: MoveTarget; dest: Check }[] = [];
  for (const t of targets) {
    if (t.keys.size === 0) continue;
    let dest = t.kind === "existing" && t.dest ? t.dest : o.newCheck(t.name, t);
    const fam = expandFamilies(src.lines, t.keys);
    const gs = [...new Set(src.lines.filter((l) => fam.has(l.key)).map((l) => l.guestNumber ?? 0).filter((g) => g > 0 && g <= 90))].sort((a, b) => a - b);
    const offset = t.kind === "existing" ? dest.guestCount : 0;
    const r = moveLines(src, dest, t.keys, {
      kind: o.moveKind, srcCheckNo: o.srcCheckNo, authEmpId: o.authEmpId, now: o.now,
      guestMap: new Map(gs.map((g, i) => [g, i + 1])), guestOffset: offset,
    });
    src = r.source; dest = r.dest;
    if (o.moveKind === "chksplit" && t.kind === "new") dest = addSplitCheckRecord(dest, o.srcCheckNo, o.authEmpId ?? "", o.now);
    dest = { ...dest, guestCount: Math.max(1, t.kind === "existing" ? dest.guestCount : 0, offset + gs.length) };
    dests.push({ target: t, dest });
  }
  return { source: src, dests, closeSource: dests.length > 0 && !hasLiveItems(src) };
}

/**
 * Merge `source` INTO `dest` (CheckViewController.m:19560-19730 — "check 2 goes on
 * check 1"): every live line and tender of the source lands on the destination
 * (fresh keys — the server dedupes by lineitemkey per check and our read-back
 * mints local keys), guests land after the destination's own; the source gets the
 * shown "CheckMerge:from:to:auth" note and is re-POSTed Is_Transferred=1 (excluded
 * from open lists/reports server-side). No void-offs — that's the iPad's merge too.
 */
export function mergeInto(dest: Check, source: Check, authName = " "): { dest: Check; source: Check } {
  const live = source.lines.filter((l) => !l.isVoid && !l.transferOut && (l.kind === "M" || l.kind === "Mo" || l.kind === "A"));
  const gs = [...new Set(live.map((l) => l.guestNumber ?? 0).filter((g) => g > 0 && g <= 90))];
  const offset = dest.guestCount;
  const keyMap = new Map<string, string>();
  const copies: CheckLine[] = [];
  for (const l of live) {
    const nk = mintLineKey(); keyMap.set(l.key, nk);
    const g = l.guestNumber;
    copies.push({
      ...l, key: nk, sent: false, parentKey: l.parentKey ? keyMap.get(l.parentKey) : undefined,
      guestNumber: g === undefined || g === 0 || g > 90 ? g : g + offset,
      trayNumber: undefined, lineNumber: undefined,
    });
  }
  const tenders = source.tenders.map((t) => ({ ...t, key: mintLineKey(), sent: false }));
  return {
    dest: { ...dest, lines: [...dest.lines, ...copies], tenders: [...dest.tenders, ...tenders], guestCount: Math.max(1, offset + gs.length) },
    source: addMergeRecord(source, source.checkNumber ?? "", dest.checkNumber ?? "", authName),
  };
}

/** Mark the current round (items + tenders) sent and advance the tray counter. */
export function markRoundSent(check: Check, closed = false): Check {
  // Stamp each fired line with the Tray_Number / Line_Number the wire gave it
  // (buildFinancialCheck numbers unsent lines 1..n in order, tray = traysSent+1)
  // so later void-offs / transfers can point back at it.
  const tray = check.traysSent + 1;
  let n = 0;
  const lines = check.lines.map((l) => (l.sent ? l : { ...l, sent: true, trayNumber: tray, lineNumber: ++n }));
  // tenders follow the items in the tray's numbering (buildFinancialCheck: items.length + i + 1)
  return {
    ...check,
    lines,
    tenders: check.tenders.map((t) => (t.sent ? t : { ...t, sent: true, trayNumber: tray, lineNumber: ++n })),
    traysSent: check.traysSent + 1,
    closed: closed || check.closed,
  };
}
