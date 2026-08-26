/*
 * Tax computation — faithful port of TaxManager.m. The chain is:
 *   Menu_Item.Menu_Item_Tax_Group_POS_ID → Menu_Item_Tax_Group → Tax_Pack
 *   (up to 5 Tax_DefN) → each def's Tax_Report_Group (Is_Inclusive).
 *
 * Per definition (TaxManager.m:1861-1899):
 *   exclusive: tax = base × (rate/100), two-step multiply at 4dp
 *              (round-down when the item's tax group has Round_Down).
 *   inclusive: tax = base − base/(1 + rate/100)  (backed out of the price).
 * Compound (Def2..5 with Is_Compounded, :1930): fold the previous def's tax
 * into the running base before computing this def.
 * Accumulate per Tax_Report_Group at 4dp; at check assembly round EACH group to
 * 2dp then sum — exclusive → grand total, inclusive → already inside prices
 * (:1105-1150). Exempt report groups are skipped.
 *
 * Not exercised by store 3 and simplified (documented): Item_Count_Trigger
 * (>1) and per-def Threshold/Rebate tiering; the multi-inclusive combined-rate
 * reconciliation (:2195) — single inclusive def is exact here.
 */

import type { Catalog } from "./menu";
import { lineExtended, type Check } from "./check";

const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const r4down = (n: number): number => Math.floor(n * 10000) / 10000;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface TaxGroupAmount {
  reportGroupId: string;
  name: string;
  amount: number;       // rounded to 2dp
  isInclusive: boolean;
  isExempt: boolean;
}
export interface TaxResult {
  taxTotal: number;     // exclusive tax added to the grand total
  inclusiveTax: number; // tax already inside line prices (display only)
  groups: TaxGroupAmount[];
}

/** Compute the check's tax, grouped by Tax_Report_Group. `exempt` holds report
 *  group ids removed from this check (whole-check exemption = remove groups). */
export function computeCheckTax(cat: Catalog, check: Check, exempt: Set<string> = new Set()): TaxResult {
  const byGroup = new Map<string, { amount: number; inclusive: boolean }>();
  const add = (trgId: string, amount: number, inclusive: boolean) => {
    const cur = byGroup.get(trgId) ?? { amount: 0, inclusive };
    cur.amount = r4(cur.amount + amount);
    byGroup.set(trgId, cur);
  };

  for (const line of check.lines) {
    if (line.isVoid || line.kind === "Co") continue;
    const item = cat.miById.get(line.menuItemId);
    const group = item?.taxGroupId ? cat.taxGroupById.get(item.taxGroupId) : undefined;
    const pack = group ? cat.taxPackById.get(group.taxPackId) : undefined;
    if (!group || !pack || pack.defs.length === 0) continue;

    let base = lineExtended(line); // extended, discount-inclusive amount
    let prevTax = 0;
    pack.defs.forEach((def, i) => {
      const trg = cat.reportGroupById.get(def.reportGroupId);
      if (!trg) return;
      if (i > 0 && def.compounded) base = r4(base + prevTax); // tax-on-tax
      let tax: number;
      if (trg.isInclusive) {
        tax = base - base / (1 + def.rate / 100);
      } else if (group.roundDown) {
        tax = r4down(r4down(base * def.rate) * 0.01);
      } else {
        tax = r4(r4(base * def.rate) * 0.01);
      }
      if (!exempt.has(def.reportGroupId)) add(def.reportGroupId, tax, trg.isInclusive);
      prevTax = tax;
    });
  }

  let taxTotal = 0, inclusiveTax = 0;
  const groups: TaxGroupAmount[] = [];
  for (const [id, g] of byGroup) {
    const trg = cat.reportGroupById.get(id);
    const isExempt = exempt.has(id);
    const amount = isExempt ? 0 : round2(Math.max(0, g.amount)); // negatives clamp to 0 (non-return)
    groups.push({ reportGroupId: id, name: trg?.name ?? id, amount, isInclusive: g.inclusive, isExempt });
    if (isExempt) continue;
    if (g.inclusive) inclusiveTax = round2(inclusiveTax + amount);
    else taxTotal = round2(taxTotal + amount);
  }
  return { taxTotal, inclusiveTax, groups };
}

/** Grand total = subtotal + exclusive tax (inclusive tax is already in prices). */
export const grandTotal = (subtotal: number, tax: TaxResult): number => round2(round2(subtotal) + round2(tax.taxTotal));

/** Balance still owed after tenders applied. */
export const balanceWithTax = (subtotal: number, tax: TaxResult, paid: number): number =>
  Math.max(0, round2(grandTotal(subtotal, tax) - paid));

/** The per-report-group breakdown for the FinancialCheck <Tax_Group_Amt> list. */
export interface WireTaxGroup { reportGroupId: string; amount: string; isExempt: boolean; }
export const taxGroupsForWire = (tax: TaxResult): WireTaxGroup[] =>
  tax.groups.map((g) => ({ reportGroupId: g.reportGroupId, amount: g.amount.toFixed(2), isExempt: g.isExempt }));
