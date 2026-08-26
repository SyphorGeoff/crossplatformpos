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

export type LineKind = "M" | "Mo" | "Co"; // menu item · modifier · course marker

export interface CheckLine {
  key: string;              // local unique key
  menuItemId: string;       // "" for course markers
  description: string;
  quantity: number;
  amount: number;           // unit price (menu item or upcharge modifier)
  kind: LineKind;
  indentLevel: number;      // 0 = item, 1+ = modifier under an item
  parentKey?: string;       // modifier → the item line it belongs to
  guestNumber?: number;     // seat/guest this line is for
  modChainId?: string;      // item's forced-modifier chain (Screen_Chain_POS_ID)
  isVoid?: boolean;
  sent?: boolean;           // already fired to the kitchen in a prior round
}

export interface Check {
  id: string;               // local check id (uuid-ish)
  revenueCenterId: string;
  tableName: string;
  guestCount: number;
  lines: CheckLine[];
  checkNumber?: string;     // server- or locally-assigned; set on first send
  openedAt: number;         // ms
}

let seq = 0;
/** Unique line/check key. Callers mint it up front so React handlers can
 *  reference the new line before the state updater has run. */
export const mintLineKey = (): string => `L${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newCheck(revenueCenterId: string, tableName = "", guestCount = 1): Check {
  return { id: mintLineKey(), revenueCenterId, tableName, guestCount, lines: [], openedAt: Date.now() };
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

/** Running subtotal across all non-void lines (tax is an M3/payments concern). */
export const checkSubtotal = (check: Check): number =>
  check.lines.reduce((sum, l) => sum + lineExtended(l), 0);

/** Lines not yet fired to the kitchen — the "new round" a send transmits. */
export const unsentLines = (check: Check): CheckLine[] => check.lines.filter((l) => !l.sent);

/** Mark every current line as sent (after a successful fire to the kitchen). */
export function markAllSent(check: Check): Check {
  return { ...check, lines: check.lines.map((l) => ({ ...l, sent: true })) };
}
