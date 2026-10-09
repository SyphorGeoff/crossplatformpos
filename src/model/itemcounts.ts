/*
 * 86 / item countdown — the client side of MenuItemCountManager.m.
 *
 * The SERVER owns the counter (Menu_Item_Counters per store + business date).
 * The client reads the counts, and keeps a LOCAL OFFSET per item for what has
 * been rung (or un-rung) since the last read, because the server only moves
 * the counter when the check posts. count = server − offset. No server row =
 * −1 = "no counter" (tile shows nothing, never disables).
 *
 * iOS decrementCounter: ring → offset +qty (localCounters); delete/void
 * (isDeleting) → offset −qty. A reload (loadMenuItemCount) clears the offsets.
 */

export interface ItemCounts {
  server: Map<string, number>;   // Menu_Item_POS_ID → Counter from the server
  offsets: Map<string, number>;  // Menu_Item_POS_ID → rung-since-reload (negative = returned)
}

export const emptyCounts = (): ItemCounts => ({ server: new Map(), offsets: new Map() });

/** A fresh read from the server replaces the counts and clears every offset. */
export function withServerCounts(rows: { menuItemId: string; counter: number }[]): ItemCounts {
  return { server: new Map(rows.map((r) => [r.menuItemId, r.counter])), offsets: new Map() };
}

/** getMenuItemCount: −1 when the item has no counter, else server − local. */
export function countFor(c: ItemCounts, menuItemId: string): number {
  const s = c.server.get(menuItemId);
  if (s === undefined) return -1;
  return s - (c.offsets.get(menuItemId) ?? 0);
}

/** Ring (+delta) or return (−delta) units of an item locally. Pure. */
export function adjustCount(c: ItemCounts, menuItemId: string, delta: number): ItemCounts {
  if (!delta) return c;
  const offsets = new Map(c.offsets);
  offsets.set(menuItemId, (offsets.get(menuItemId) ?? 0) + delta);
  return { server: c.server, offsets };
}

/**
 * The stock gate before adding `diff` more units (updateQuantityForLineItems
 * :10910-10930 / tile disable at 0): null = allowed, else the iPad's message.
 */
export function stockRefusal(c: ItemCounts, menuItemId: string, diff: number): string | null {
  if (diff <= 0) return null;
  const n = countFor(c, menuItemId);
  if (n < 0) return null;
  if (n === 0) return "No items in stock";
  if (diff > n) return "Not enough items in stock";
  return null;
}
