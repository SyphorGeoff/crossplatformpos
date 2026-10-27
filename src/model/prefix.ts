/*
 * Menu-item prefixes (ToppingPrefix / ToppingGroup) — CUP, BOWL x1.4, No, Dbl…
 * Ported from the iPad:
 *   bar while ordering   ItemsTableViewController :1284-1330 (prefixes of the screen group's
 *                        topping group: the default first, then the Topping_ToppingPrefix rows,
 *                        sorted by InventoryMultiplier; default pre-selected) and
 *                        resetPrefixForRootScreenGroup :1677 (back to the default after every ring)
 *   pricing on ring      FinancialCheckManager :8828-8960
 *   change on a line     CheckTableCellView prefixButton → changePrefix → ToppingPrefixViewController
 *                        showWithToppingGroup:Menu_Item.main_ToppingGroup_ID; pick re-prices the line
 *                        from the item's base price (CheckViewController :13341-13646)
 *   wire                 <toppingPrefix_ID> + <pfix>; Quantity = count × InventoryMultiplier
 *   chit / KDS           first 3 letters of the prefix padded to 4 ahead of the name
 */

import type { MenuItem, ToppingGroup, ToppingGroupPrefix, ToppingPrefix } from "./catalog";
import type { Check, CheckLine } from "./check";

export interface PrefixDefs {
  prefixById: Map<string, ToppingPrefix>;
  toppingGroupById: Map<string, ToppingGroup>;
  toppingGroupPrefixes: ToppingGroupPrefix[];
}

/** The prefixes a topping group offers, in the iPad's order: the default first, then the
 *  group's other prefixes, the whole list sorted by InventoryMultiplier (stable). */
export function prefixesForGroup(defs: PrefixDefs, groupId: string): ToppingPrefix[] {
  const g = defs.toppingGroupById.get(groupId);
  if (!g) return [];
  const out: ToppingPrefix[] = [];
  const def = g.defaultPrefixId ? defs.prefixById.get(g.defaultPrefixId) : undefined;
  if (def) out.push(def);
  for (const row of defs.toppingGroupPrefixes) {
    if (row.groupId !== groupId || row.prefixId === g.defaultPrefixId) continue;
    const p = defs.prefixById.get(row.prefixId);
    if (p && !out.includes(p)) out.push(p);
  }
  return out.sort((a, b) => a.inventoryMultiplier - b.inventoryMultiplier);
}

/** The group's default prefix (what the bar pre-selects), if it has one. */
export function defaultPrefixOf(defs: PrefixDefs, groupId: string): ToppingPrefix | undefined {
  const g = defs.toppingGroupById.get(groupId);
  return g?.defaultPrefixId ? defs.prefixById.get(g.defaultPrefixId) : undefined;
}

/** A price-tier selector prefix (mode 2) picks the item's Nth price: 2 = Happy_Hour_Price, N = Price_Tier_N. */
function tierPrice(item: MenuItem | undefined, tier: number): number | undefined {
  if (!item) return undefined;
  const raw = item._raw;
  const pick = (k: string) => { const v = raw[k]; const s = v == null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v); return s.trim(); };
  const v = tier === 2 ? pick("Happy_Hour_Price") : (pick(`Price_Tier_${tier}`) || pick(`price_Tier_${tier}`));
  return v === "" ? undefined : Number(v) || 0;
}

/** Unit price of an item under a prefix (FinancialCheckManager :8838-8960):
 *    mode 1  → base + PriceMultiplier (a fixed dollar add)
 *    mode 2  → the item's price tier PriceMultiplier (falls back to the base when the tier is empty)
 *    else    → base × PriceMultiplier
 *  A $0 base stays $0 (the iPad's `if Amount == 0 → 0` guard). */
export function prefixedUnitPrice(base: number, prefix: ToppingPrefix | undefined, item?: MenuItem): number {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  if (!prefix) return r2(base);
  if (base === 0) return 0;
  if (prefix.mode === 1) return r2(base + prefix.priceMultiplier);
  if (prefix.mode === 2) return r2(tierPrice(item, Math.trunc(prefix.priceMultiplier)) ?? base);
  return r2(base * prefix.priceMultiplier);
}

/** Quantity as the iPad writes it on the wire: count × InventoryMultiplier, as an int when whole,
 *  one decimal when exact, else two. */
export function wireQuantity(count: number, inventoryMultiplier = 1): string {
  const q = count * inventoryMultiplier;
  if (q === Math.trunc(q)) return String(Math.trunc(q));
  const one = q.toFixed(1);
  return Number(one) === q ? one : q.toFixed(2);
}

/** A modifier rides its ancestors' prefixes (getParentPriceMultiplerWithParentTray /
 *  getParentQtyMultiplerWithParentTray :27124-27190): price × every ancestor's plain (mode 0)
 *  PriceMultiplier, quantity × every ancestor's InventoryMultiplier (> 0 only). */
export function ancestorMultipliers(lines: CheckLine[], parentKey: string | undefined, defs?: Pick<PrefixDefs, "prefixById">): { price: number; qty: number } {
  let price = 1, qty = 1;
  let k = parentKey;
  for (let depth = 0; k && depth < 20; depth++) {
    const p = lines.find((l) => l.key === k);
    if (!p) break;
    const tp = p.prefixId ? defs?.prefixById.get(p.prefixId) : undefined;
    if (tp) {
      if (tp.mode === 0) price *= tp.priceMultiplier;
      if (tp.inventoryMultiplier > 0) qty *= tp.inventoryMultiplier;
    }
    k = p.parentKey;
  }
  return { price, qty };
}

/** Stamp (or clear, with `prefix` undefined) a prefix on an unsent line and re-price it from its base
 *  unit price. `baseAmount` is remembered on the line so a later change prices from the pre-prefix
 *  price, like the iPad re-pricing from getPriceForMenuItem. A modifier line also takes its ancestors'
 *  multipliers (pass `defs` to resolve them); its stored `prefixQtyMult` is the COMBINED quantity factor. */
export function setLinePrefix(check: Check, key: string, prefix: ToppingPrefix | undefined, item?: MenuItem, defs?: Pick<PrefixDefs, "prefixById">): Check {
  return {
    ...check,
    lines: check.lines.map((l) => {
      if (l.key !== key || (l.kind !== "M" && l.kind !== "Mo") || l.sent) return l;
      const base = l.baseAmount ?? l.amount;
      const anc = l.kind === "Mo" ? ancestorMultipliers(check.lines, l.parentKey, defs) : { price: 1, qty: 1 };
      const unit = prefixedUnitPrice(base, prefix, item);
      const next: CheckLine = { ...l, baseAmount: base, amount: unit === 0 ? 0 : Math.round(unit * anc.price * 100) / 100 };
      const qtyMult = (prefix ? prefix.inventoryMultiplier : 1) * anc.qty;
      delete next.prefixId; delete next.pfix; delete next.prefixQtyMult;
      if (prefix) { next.prefixId = prefix.id; next.pfix = prefix.name; }
      if (prefix || qtyMult !== 1) next.prefixQtyMult = qtyMult;
      return next;
    }),
  };
}

/** The next prefix when the chip on a line is tapped: cycles through the group's list in bar order,
 *  starting from the line's current prefix (a prefix outside the list restarts at the first). */
export function nextPrefix(list: ToppingPrefix[], currentId: string | undefined): ToppingPrefix | undefined {
  if (list.length === 0) return undefined;
  const i = list.findIndex((p) => p.id === currentId);
  return list[(i + 1) % list.length];
}

/** "BOW Tomato Soup" — the chit / KDS name: the first three letters of the prefix padded to four
 *  (PrintManager parseMenuItem, DisplayManager getKDSOrderString :1140-1152). */
export function prefixedName(pfix: string | undefined, name: string): string {
  if (!pfix) return name;
  return pfix.slice(0, 3).padEnd(4) + name;
}
