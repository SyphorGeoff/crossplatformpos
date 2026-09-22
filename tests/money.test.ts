/*
 * Block C money logic: item-level adjustments (addAdjustmentsToLineItems math),
 * automatic gratuity per guest, the tax rules for split markers / parented
 * adjustments / exempt groups, the Parent_* wire link for item discounts, and
 * removing an unsent tender without dropping sent ones.
 */

import { describe, expect, it } from "vitest";
import { applyAutoGratuity, applyItemAdjustments, markRoundSent, removeTender, type Check, type CheckLine } from "@/model/check";
import { computeCheckTax } from "@/model/tax";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";
import type { Catalog } from "@/model/menu";

const line = (key: string, amount: number, o: Partial<CheckLine> = {}): CheckLine =>
  ({ key, menuItemId: "sales", description: key, amount, quantity: 1, kind: "M", indentLevel: 0, guestNumber: 1, ...o });
const check = (lines: CheckLine[], guestCount = 1): Check =>
  ({ id: "C", revenueCenterId: "1", tableName: "", guestCount, lines, tenders: [], traysSent: 0, openedAt: 0 });
const adjs = (c: Check) => c.lines.filter((l) => l.kind === "A");

const pct = { id: "D10", name: "10% off", isPercentage: true, isServiceCharge: false, taxPackId: "", affectsTaxes: true };
const fixed = { id: "D5", name: "$ off", isPercentage: false, isServiceCharge: false, taxPackId: "", affectsTaxes: true };

describe("applyItemAdjustments", () => {
  it("percent: one line per item, linked to the item, carrying its guest", () => {
    const c = applyItemAdjustments(check([line("a", 10, { guestNumber: 2 }), line("b", 20)]), pct, 10, ["a", "b"], "33");
    const a = adjs(c);
    expect(a.map((l) => [l.parentKey, l.amount, l.guestNumber, l.authEmpId])).toEqual([["a", -1, 2, "33"], ["b", -2, 1, "33"]]);
    expect(a.every((l) => l.indentLevel === 1 && l.adjustmentId === "D10")).toBe(true);
    // sits right under its item
    expect(c.lines.map((l) => l.key.length ? l.parentKey ?? l.key : "")).toEqual(["a", "a", "b", "b"]);
  });
  it("percent applies to the item NET of earlier discounts", () => {
    let c = applyItemAdjustments(check([line("a", 10)]), pct, 50, ["a"]);
    c = applyItemAdjustments(c, { ...pct, id: "D2" }, 50, ["a"]);
    expect(adjs(c).map((l) => l.amount)).toEqual([-5, -2.5]);
  });
  it("fixed: shared by base, last item takes the remainder so pieces sum to the entry", () => {
    const c = applyItemAdjustments(check([line("a", 10), line("b", 10), line("c", 10)]), fixed, 10, ["a", "b", "c"]);
    const amts = adjs(c).map((l) => l.amount);
    expect(amts).toEqual([-3.33, -3.33, -3.34]);
  });
  it("caps a discount at the item's net (never below zero)", () => {
    const c = applyItemAdjustments(check([line("a", 4)]), fixed, 10, ["a"]);
    expect(adjs(c).map((l) => l.amount)).toEqual([-4]);
  });
  it("service charge is positive and uses the gross base", () => {
    let c = applyItemAdjustments(check([line("a", 10)]), pct, 50, ["a"]);
    c = applyItemAdjustments(c, { ...pct, id: "SC", isServiceCharge: true }, 10, ["a"]);
    expect(adjs(c).map((l) => l.amount)).toEqual([-5, 1]);
  });
  it("ignores keys that are not live menu items", () => {
    const c = applyItemAdjustments(check([line("a", 10, { isVoid: true }), line("m", 1, { kind: "Mo", parentKey: "a" })]), pct, 10, ["a", "m", "zzz"]);
    expect(adjs(c)).toHaveLength(0);
  });
});

const grat = { id: "AG", name: "Auto Grat", isPercentage: true, isServiceCharge: true, taxPackId: "", affectsTaxes: false, partySize: 8, amount: 18, departmentOk: () => true };

describe("applyAutoGratuity", () => {
  it("does nothing below Party_Size", () => {
    expect(adjs(applyAutoGratuity(check([line("a", 100)], 7), [grat]))).toHaveLength(0);
  });
  it("one line per guest with items, guest-stamped, at Amount% of that guest's items", () => {
    const c = applyAutoGratuity(check([line("a", 100, { guestNumber: 1 }), line("b", 50, { guestNumber: 3 })], 8), [grat]);
    expect(adjs(c).map((l) => [l.guestNumber, l.amount, l.adjustmentId])).toEqual([[1, 18, "AG"], [3, 9, "AG"]]);
  });
  it("is idempotent when nothing changed, replaces an unsent stale charge", () => {
    let c = applyAutoGratuity(check([line("a", 100)], 8), [grat]);
    const same = applyAutoGratuity(c, [grat]);
    expect(same).toBe(c);
    c = { ...c, lines: [...c.lines, line("b", 100)] };
    c = applyAutoGratuity(c, [grat]);
    expect(adjs(c).map((l) => l.amount)).toEqual([36]);
  });
  it("voids a SENT stale charge and adds the fresh one", () => {
    let c = markRoundSent(applyAutoGratuity(check([line("a", 100)], 8), [grat]));
    c = applyAutoGratuity({ ...c, lines: [...c.lines, line("b", 100)] }, [grat]);
    const a = adjs(c);
    expect(a.filter((l) => l.isVoid).map((l) => l.amount).sort()).toEqual([-18, 18]);
    expect(a.filter((l) => !l.isVoid).map((l) => l.amount)).toEqual([36]);
  });
  it("skips items outside the gratuity's departments", () => {
    const c = applyAutoGratuity(check([line("a", 100), line("b", 100, { menuItemId: "bar" })], 8), [{ ...grat, departmentOk: (l) => l.menuItemId !== "bar" }]);
    expect(adjs(c).map((l) => l.amount)).toEqual([18]);
  });
});

function mkCat(): Catalog {
  return {
    miById: new Map([["sales", { id: "sales", taxGroupId: "1" }], ["notax", { id: "notax", taxGroupId: "2" }]]),
    taxGroupById: new Map([["1", { id: "1", taxPackId: "1", roundDown: false }], ["2", { id: "2", taxPackId: "2", roundDown: false }]]),
    taxPackById: new Map([
      ["1", { defs: [{ threshold: 0, rebateRate: 0, compounded: false, name: "", rate: 10, reportGroupId: "2" }] }],
      ["2", { defs: [{ threshold: 0, rebateRate: 0, compounded: false, name: "", rate: 0, reportGroupId: "3" }] }],
    ]),
    reportGroupById: new Map([["2", { id: "2", name: "Sales Tax", isInclusive: false }], ["3", { id: "3", name: "No Tax", isInclusive: true }]]),
  } as unknown as Catalog;
}

describe("computeCheckTax — block C rules", () => {
  it("an Is_Split marker is not taxed", () => {
    const t = computeCheckTax(mkCat(), check([line("a", 10), line("s", -10, { isSplit: true })]));
    expect(t.taxTotal).toBe(1);
  });
  it("an item-level discount without its own pack taxes via the parent's pack", () => {
    const c = applyItemAdjustments(check([line("a", 10)]), pct, 50, ["a"]);
    expect(computeCheckTax(mkCat(), c).taxTotal).toBe(0.5);
  });
  it("exempt groups stay in tax.groups at $0, flagged, so Remove All Tax can union them", () => {
    const t = computeCheckTax(mkCat(), check([line("a", 10)]), new Set(["2"]));
    expect(t.taxTotal).toBe(0);
    expect(t.groups.map((g) => [g.reportGroupId, g.amount, g.isExempt])).toEqual([["2", 0, true]]);
  });
});

const ctx: SendContext = { isisVer: "1", storeId: "997", securityToken: "t", terminalPosId: "58", employeePosId: "1", businessDateId: "9", checkNo: "5" };

describe("wire: item-level adjustment", () => {
  it("names a SENT parent by its stamped tray/line", () => {
    let c = markRoundSent(check([line("a", 10), line("b", 20)]));
    c = applyItemAdjustments(c, pct, 10, ["b"]);
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toMatch(/Type="A"[^>]*>.*<Parent_LineItem_ID>2<\/Parent_LineItem_ID><Parent_Tray_Number>1<\/Parent_Tray_Number>/);
    expect(xml).toMatch(/<Guest_Num>1<\/Guest_Num>/);
    expect(xml).toMatch(/<Adjustment_POS_ID>D10<\/Adjustment_POS_ID>/);
    expect(xml).toMatch(/<Line_Amount>-2.00<\/Line_Amount>/);
  });
  it("names an UNSENT parent by its number in the same tray", () => {
    const c = applyItemAdjustments(check([line("a", 10)]), pct, 10, ["a"]);
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toMatch(/Type="A"[^>]*>.*<Parent_LineItem_ID>1<\/Parent_LineItem_ID><Parent_Tray_Number>1<\/Parent_Tray_Number>/);
  });
});

describe("removeTender", () => {
  it("removes only the named unsent tender; sent tenders stay", () => {
    const c: Check = { ...check([]), tenders: [
      { key: "t1", tenderId: "1", name: "Cash", amount: 5, tip: 0, change: 0, sent: true },
      { key: "t2", tenderId: "2", name: "Visa", amount: 5, tip: 0, change: 0 },
      { key: "t3", tenderId: "2", name: "Visa", amount: 5, tip: 0, change: 0 },
    ] };
    expect(removeTender(c, "t2").tenders.map((t) => t.key)).toEqual(["t1", "t3"]);
    expect(removeTender(c, "t1").tenders.map((t) => t.key)).toEqual(["t1", "t2", "t3"]);
  });
});
