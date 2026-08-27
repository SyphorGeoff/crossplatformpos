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

export type LineKind = "M" | "Mo" | "Co" | "A"; // menu item · modifier · course marker · adjustment

export interface CheckLine {
  key: string;              // local unique key
  menuItemId: string;       // "" for course markers / adjustments
  description: string;
  quantity: number;
  amount: number;           // unit price (menu item / upcharge modifier); signed for adjustments
  kind: LineKind;
  indentLevel: number;      // 0 = item, 1+ = modifier under an item
  parentKey?: string;       // modifier → the item line it belongs to
  guestNumber?: number;     // seat/guest this line is for
  modChainId?: string;      // item's forced-modifier chain (Screen_Chain_POS_ID)
  adjustmentId?: string;    // Adjustment_POS_ID (kind "A")
  taxPackId?: string;       // tax pack for a tax-affecting adjustment (kind "A")
  authEmpId?: string;       // AuthorizingEmployee_ID (void / restricted adjustment)
  voidPosId?: string;       // Void_POS_ID (void reason)
  isVoid?: boolean;
  transferOut?: boolean;    // a negative void-off line moving an item off this check (split/transfer)
  sent?: boolean;           // already fired to the kitchen in a prior round
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
  traysSent: number;        // service rounds already POSTed (tray numbering)
  closed?: boolean;         // settled + closed (Is_Closed/Is_Settled on the wire)
  openedAt: number;         // ms
}

let seq = 0;
/** Unique line/check key. Callers mint it up front so React handlers can
 *  reference the new line before the state updater has run. */
export const mintLineKey = (): string => `L${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newCheck(revenueCenterId: string, tableName = "", guestCount = 1, diningTableId?: string): Check {
  return { id: mintLineKey(), revenueCenterId, tableName, diningTableId, guestCount, lines: [], tenders: [], traysSent: 0, openedAt: Date.now() };
}

/** Append a menu item as a new order line (quantity 1) with the caller's key. */
export function addItemLine(check: Check, item: MenuItem, key: string, guestNumber?: number): Check {
  const line: CheckLine = {
    key, menuItemId: item.id, description: item.name,
    quantity: 1, amount: Number(item.price) || 0, kind: "M", indentLevel: 0,
    modChainId: item.modChainId || undefined, guestNumber,
  };
  return { ...check, lines: [...check.lines, line] };
}

/** Insert a modifier line directly beneath its parent item (and any siblings). */
export function addModifierLine(
  check: Check, parentKey: string, item: MenuItem, amount: number, indentLevel = 1,
): Check {
  const line: CheckLine = {
    key: mintLineKey(), menuItemId: item.id, description: item.name,
    quantity: 1, amount, kind: "Mo", indentLevel, parentKey,
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
export function removeLine(check: Check, key: string): Check {
  return { ...check, lines: check.lines.filter((l) => l.key !== key && l.parentKey !== key) };
}

export function setQuantity(check: Check, key: string, quantity: number): Check {
  if (quantity <= 0) return removeLine(check, key);
  return { ...check, lines: check.lines.map((l) => (l.key === key ? { ...l, quantity } : l)) };
}

/** A line's extended price (unit × qty). Modifiers may carry an upcharge. */
export const lineExtended = (l: CheckLine): number => (l.isVoid ? 0 : l.amount * l.quantity);

/** Running subtotal across current lines — items + adjustments (discounts are
 *  negative), excluding void/void-off lines. */
export const checkSubtotal = (check: Check): number =>
  check.lines.reduce((sum, l) => sum + (l.transferOut || l.isVoid ? 0 : lineExtended(l)), 0);

/** Append an adjustment (discount/comp/service charge) as a Type="A" line.
 *  `amount` is the signed extended dollar amount (discounts negative). */
export function addAdjustmentLine(check: Check, a: {
  adjustmentId: string; name: string; amount: number; taxPackId?: string; authEmpId?: string;
}): Check {
  const line: CheckLine = {
    key: mintLineKey(), menuItemId: "", description: a.name, quantity: 1, amount: a.amount,
    kind: "A", indentLevel: 0, adjustmentId: a.adjustmentId, taxPackId: a.taxPackId, authEmpId: a.authEmpId,
  };
  return { ...check, lines: [...check.lines, line] };
}

/** Void a line. An unsent line is dropped; a sent line is struck and gets a
 *  reversing negative Is_Void line to cancel it server-side (recon C7). */
export function voidLine(check: Check, key: string, voidPosId: string, authEmpId: string): Check {
  const line = check.lines.find((l) => l.key === key);
  if (!line) return check;
  if (!line.sent) return removeLine(check, key);
  const reversal: CheckLine = {
    ...line, key: mintLineKey(), amount: -Math.abs(line.amount), isVoid: true, sent: false,
    voidPosId, authEmpId, parentKey: undefined,
  };
  const lines = check.lines.map((l) => (l.key === key ? { ...l, isVoid: true } : l));
  return { ...check, lines: [...lines, reversal] };
}

/** Total applied by tenders so far (change is not applied; it's returned cash). */
export const tenderApplied = (check: Check): number =>
  check.tenders.reduce((sum, t) => sum + t.amount, 0);

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

export function removeTender(check: Check, key: string): Check {
  return { ...check, tenders: check.tenders.filter((t) => t.key !== key && t.sent !== true) };
}

/** Lines not yet fired to the kitchen — the "new round" a send transmits. */
export const unsentLines = (check: Check): CheckLine[] => check.lines.filter((l) => !l.sent);
export const unsentTenders = (check: Check): TenderLine[] => check.tenders.filter((t) => !t.sent);

/**
 * Split selected item lines onto a brand-new check (move items). Modifiers of a
 * selected item move with it. Already-sent lines leave a negative Transfered_Out
 * void-off on the source (to cancel them server-side, recon C); unsent lines are
 * simply dropped. The new check carries positive copies (same table).
 */
export function splitToNewCheck(source: Check, keys: Set<string>): { source: Check; dest: Check } {
  // Expand selection to include modifiers hanging off a selected parent.
  const selected = new Set<string>();
  for (const l of source.lines) {
    if (keys.has(l.key) || (l.parentKey && selected.has(l.parentKey))) selected.add(l.key);
  }
  const dest = newCheck(source.revenueCenterId, source.tableName, source.guestCount, source.diningTableId);
  const keyMap = new Map<string, string>();
  const destLines: CheckLine[] = [];
  for (const l of source.lines) {
    if (!selected.has(l.key)) continue;
    const nk = mintLineKey();
    keyMap.set(l.key, nk);
    destLines.push({ ...l, key: nk, sent: false, transferOut: false, parentKey: l.parentKey ? keyMap.get(l.parentKey) : undefined });
  }
  dest.lines = destLines;

  const srcLines: CheckLine[] = [];
  for (const l of source.lines) {
    if (!selected.has(l.key)) { srcLines.push(l); continue; }
    if (l.sent) srcLines.push({ ...l, key: mintLineKey(), amount: -Math.abs(l.amount), transferOut: true, sent: false });
    // unsent selected lines: dropped (never reached the server)
  }
  return { source: { ...source, lines: srcLines }, dest };
}

/** Mark the current round (items + tenders) sent and advance the tray counter. */
export function markRoundSent(check: Check, closed = false): Check {
  return {
    ...check,
    lines: check.lines.map((l) => ({ ...l, sent: true })),
    tenders: check.tenders.map((t) => ({ ...t, sent: true })),
    traysSent: check.traysSent + 1,
    closed: closed || check.closed,
  };
}
