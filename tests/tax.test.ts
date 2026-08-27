/*
 * Tax computation — the TaxManager algorithm ported in model/tax.ts.
 * Covers exclusive, no-tax, inclusive back-out, per-group 2dp rounding,
 * multi-group grouping, and compounded definitions.
 */

import { describe, expect, it } from "vitest";
import { computeCheckTax, grandTotal, balanceWithTax, taxGroupsForWire } from "@/model/tax";
import type { Catalog } from "@/model/menu";
import type { Check, CheckLine } from "@/model/check";

// Minimal catalog with only the fields computeCheckTax reads.
function mkCat(o: {
  items: { id: string; taxGroupId: string }[];
  groups: { id: string; taxPackId: string; roundDown?: boolean }[];
  packs: { id: string; defs: { rate: number; reportGroupId: string; compounded?: boolean }[] }[];
  reportGroups: { id: string; name: string; isInclusive: boolean }[];
}): Catalog {
  return {
    miById: new Map(o.items.map((i) => [i.id, i])),
    taxGroupById: new Map(o.groups.map((g) => [g.id, { roundDown: false, ...g }])),
    taxPackById: new Map(o.packs.map((p) => [p.id, { defs: p.defs.map((d) => ({ threshold: 0, rebateRate: 0, compounded: false, name: "", ...d })) }])),
    reportGroupById: new Map(o.reportGroups.map((r) => [r.id, r])),
  } as unknown as Catalog;
}

const line = (menuItemId: string, amount: number, quantity = 1): CheckLine =>
  ({ key: `k${menuItemId}${amount}`, menuItemId, description: "", amount, quantity, kind: "M", indentLevel: 0 });
const check = (lines: CheckLine[]): Check =>
  ({ id: "C", revenueCenterId: "1", tableName: "", guestCount: 1, lines, tenders: [], traysSent: 0, openedAt: 0 });

// Store-3-shaped fixtures: group1→pack1 Sales Tax 10% exclusive (TRG 2),
// group2→pack2 No Tax (TRG 3), group3→pack3 Inclusive 10% (TRG 1 inclusive).
const storeCat = mkCat({
  items: [{ id: "sales", taxGroupId: "1" }, { id: "notax", taxGroupId: "2" }, { id: "incl", taxGroupId: "3" }],
  groups: [{ id: "1", taxPackId: "1" }, { id: "2", taxPackId: "2" }, { id: "3", taxPackId: "3" }],
  packs: [
    { id: "1", defs: [{ rate: 10, reportGroupId: "2" }] },
    { id: "2", defs: [{ rate: 0, reportGroupId: "3" }] },
    { id: "3", defs: [{ rate: 10, reportGroupId: "1" }] },
  ],
  reportGroups: [{ id: "1", name: "Inclusive Tax", isInclusive: true }, { id: "2", name: "Sales Tax", isInclusive: false }, { id: "3", name: "No Tax", isInclusive: true }],
});

describe("computeCheckTax — exclusive", () => {
  it("10% on top: $10 → $1.00 tax, total $11.00", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 10)]));
    expect(t.taxTotal).toBe(1);
    expect(t.inclusiveTax).toBe(0);
    expect(grandTotal(10, t)).toBe(11);
  });
  it("multiplies by quantity: $10 × 3 = $30 → $3.00 tax", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 10, 3)]));
    expect(t.taxTotal).toBe(3);
  });
});

describe("computeCheckTax — no tax", () => {
  it("a 0% / No-Tax item adds nothing", () => {
    const t = computeCheckTax(storeCat, check([line("notax", 5)]));
    expect(t.taxTotal).toBe(0);
    expect(grandTotal(5, t)).toBe(5);
  });
});

describe("computeCheckTax — inclusive back-out", () => {
  it("$11 inclusive 10% → $1.00 already inside; total stays $11", () => {
    const t = computeCheckTax(storeCat, check([line("incl", 11)]));
    expect(t.inclusiveTax).toBe(1);       // 11 - 11/1.1 = 1.00
    expect(t.taxTotal).toBe(0);
    expect(grandTotal(11, t)).toBe(11);   // not added on top
  });
});

describe("computeCheckTax — rounding & grouping", () => {
  it("rounds each report group to 2dp: $0.99 × 10% = 0.099 → $0.10", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 0.99)]));
    expect(t.taxTotal).toBe(0.1);
  });
  it("keeps exclusive and inclusive in separate groups", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 10), line("incl", 11)]));
    expect(t.taxTotal).toBe(1);
    expect(t.inclusiveTax).toBe(1);
    expect(t.groups.map((g) => g.reportGroupId).sort()).toEqual(["1", "2"]);
  });
});

describe("computeCheckTax — compound", () => {
  it("second def taxes base + first def's tax", () => {
    const cat = mkCat({
      items: [{ id: "x", taxGroupId: "g" }],
      groups: [{ id: "g", taxPackId: "p" }],
      packs: [{ id: "p", defs: [{ rate: 10, reportGroupId: "A" }, { rate: 10, reportGroupId: "B", compounded: true }] }],
      reportGroups: [{ id: "A", name: "A", isInclusive: false }, { id: "B", name: "B", isInclusive: false }],
    });
    const t = computeCheckTax(cat, check([line("x", 100)]));
    // def1: 100 × 10% = 10 (group A). def2 compounded: (100+10) × 10% = 11 (group B).
    expect(t.groups.find((g) => g.reportGroupId === "A")!.amount).toBe(10);
    expect(t.groups.find((g) => g.reportGroupId === "B")!.amount).toBe(11);
    expect(t.taxTotal).toBe(21);
  });
});

describe("adjustments", () => {
  it("a tax-affecting discount reduces the tax (its pack, negative amount)", () => {
    const c = check([
      line("sales", 10),
      { key: "d", menuItemId: "", description: "Comp", quantity: 1, amount: -5, kind: "A", indentLevel: 0, taxPackId: "1" },
    ]);
    const t = computeCheckTax(storeCat, c);
    expect(t.taxTotal).toBe(0.5); // (10 − 5) × 10%
  });
  it("a non-tax discount (no taxPackId) leaves tax on the full item", () => {
    const c = check([
      line("sales", 10),
      { key: "d", menuItemId: "", description: "Comp", quantity: 1, amount: -5, kind: "A", indentLevel: 0 },
    ]);
    expect(computeCheckTax(storeCat, c).taxTotal).toBe(1); // 10 × 10%, discount doesn't affect tax
  });
});

describe("balance & wire", () => {
  it("balance due includes tax minus tenders", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 10)]));
    expect(balanceWithTax(10, t, 0)).toBe(11);
    expect(balanceWithTax(10, t, 11)).toBe(0);
  });
  it("taxGroupsForWire emits report-group id + 2dp amount + exempt flag", () => {
    const t = computeCheckTax(storeCat, check([line("sales", 10)]));
    expect(taxGroupsForWire(t)).toEqual([{ reportGroupId: "2", amount: "1.00", isExempt: false }]);
  });
});
