/*
 * Block A — sent-line removals that must survive a server round-trip:
 * void reversals name their original (Void_Line_Item_ID / Void_Parent_Tray_Number),
 * unhold re-fires via a hidden void-off, and the pull-back parser nets reversals
 * against originals exactly like the iPad's isValid: (FinancialCheckManager.m).
 */

import { describe, expect, it } from "vitest";
import { addItemLine, addModifierLine, checkSubtotal, holdUnholdLines, markRoundSent, newCheck, voidLine } from "@/model/check";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";
import type { XmlDict } from "@/protocol/hbroker";
import { parseCheckLines } from "@/protocol/tables";

const item = (id: string, price = 10) => ({ id, name: `item ${id}`, price: String(price) } as any);
const ctx: SendContext = { isisVer: "1", storeId: "3", securityToken: "T", terminalPosId: "20", employeePosId: "1", businessDateId: "9", checkNo: "200001" };
const names = { menuItemName: (id: string) => `MI ${id}`, tenderName: (id: string) => `T ${id}`, adjustmentName: (id: string) => `ADJ ${id}` };

describe("voidLine (sent item family)", () => {
  it("strikes the originals and emits reversals that name them via Void_Line_Item_ID / Void_Parent_Tray_Number", () => {
    let c = newCheck("1"); c = addItemLine(c, item("100", 7), "a", 1); c = addModifierLine(c, "a", item("m", 1), 1);
    c = markRoundSent(c);                                        // tray 1: a=1, m=2
    c = voidLine(c, "a", "V9", "9999");
    const originals = c.lines.filter((l) => l.sent);
    expect(originals.every((l) => l.isVoid)).toBe(true);        // struck, still listed
    const rev = c.lines.filter((l) => !l.sent);
    expect(rev.map((l) => [l.amount, l.parentTrayNumber, l.parentLineNumber])).toEqual([[-7, 1, 1], [-1, 1, 2]]);
    expect(checkSubtotal(c)).toBe(0);
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<Void_Line_Item_ID>1</Void_Line_Item_ID><Void_Parent_Tray_Number>1</Void_Parent_Tray_Number>");
    expect(xml).toContain("<Void_Line_Item_ID>2</Void_Line_Item_ID><Void_Parent_Tray_Number>1</Void_Parent_Tray_Number>");
    expect(xml).toContain("<Void_POS_ID>V9</Void_POS_ID>");
  });
  it("an unsent family is simply removed", () => {
    let c = newCheck("1"); c = addItemLine(c, item("100"), "a", 1); c = addModifierLine(c, "a", item("m", 0), 0);
    expect(voidLine(c, "a", "V9", "1").lines).toHaveLength(0);
  });
});

describe("holdUnholdLines", () => {
  it("unsent → toggles Is_Held", () => {
    let c = newCheck("1"); c = addItemLine(c, item("100"), "a", 1);
    c = holdUnholdLines(c, new Set(["a"])); expect(c.lines[0].held).toBe(true);
    c = holdUnholdLines(c, new Set(["a"])); expect(c.lines[0].held).toBe(false);
  });
  it("sent + held → hidden void-off replaces the original, fresh unheld copy re-fires; no double count", () => {
    let c = newCheck("1"); c = addItemLine(c, item("100", 11.25), "a", 2); c = addModifierLine(c, "a", item("m", 0), 0);
    c = holdUnholdLines(c, new Set(["a"])); c = markRoundSent(c);      // sent + held, tray 1
    c = holdUnholdLines(c, new Set([c.lines[0].key]));
    expect(c.lines.some((l) => l.key === "a")).toBe(false);            // original gone
    const offs = c.lines.filter((l) => l.transferOut);
    expect(offs.map((l) => [l.amount, l.parentLineNumber])).toEqual([[-11.25, 1], [-0, 2]]);
    const fresh = c.lines.filter((l) => !l.sent && !l.transferOut);
    expect(fresh.map((l) => [l.kind, l.held, l.guestNumber])).toEqual([["M", false, 2], ["Mo", false, 2]]);
    expect(fresh[1].parentKey).toBe(fresh[0].key);
    expect(checkSubtotal(c)).toBe(11.25);                              // once, not twice
  });
});

// A LineItem exactly as parseXmlResponse shapes it: attributes and leaf children become string keys.
const li = (a: Record<string, string>, kids: Record<string, string | number>): XmlDict => ({
  Is_Held: a.held ?? "0", Is_Void: a.void ?? "0", Transfered_Out: a.xfer ?? "0", Print_On_Check: "1", Show_On_Display: "1",
  Type: a.type ?? "M", Finalized: "0", Is_Split: a.split ?? "0", lineitemkey: a.key ?? "1", posted: "1",
  ...Object.fromEntries(Object.entries(kids).map(([k, v]) => [k, String(v)])),
});

describe("parseCheckLines (pull-back netting = isValid:)", () => {
  const fc: XmlDict = { Guest_Count: "2", Check_No: "580044", Tray: [
    { Tray_Number: "1", LineItem: [
      li({}, { Guest_Num: 1, Quantity: 1, Line_Number: 1, MenuItem_POS_ID: 100, Line_Amount: "7.00" }),            // voided below
      li({ held: "1" }, { Guest_Num: 1, applied_to_guests: 0, Quantity: 1, Line_Number: 2, MenuItem_POS_ID: 200, Line_Amount: "3.00" }), // whole-table, held
      li({}, { Guest_Num: 2, Quantity: 1, Line_Number: 3, MenuItem_POS_ID: 300, Line_Amount: "9.00" }),            // transferred below
      li({}, { Guest_Num: 2, Parent_LineItem_ID: 3, Parent_Tray_Number: 1, Quantity: 1, Line_Number: 4, MenuItem_POS_ID: 301, Line_Amount: "0.00" }), // its modifier
      li({ type: "A" }, { Guest_Num: 1, Quantity: 1, Line_Number: 5, Adjustment_POS_ID: 55, Line_Amount: "-2.00" }),
      li({ type: "R" }, { Quantity: 1, Line_Number: 6, Reference: "NOTSHOWN:GuestCount::2", Line_Amount: "0.00" }),
    ] },
    { Tray_Number: "2", LineItem: [
      li({ void: "1" }, { Guest_Num: 1, Void_Line_Item_ID: 1, Void_Parent_Tray_Number: 1, Quantity: 1, Line_Number: 1, MenuItem_POS_ID: 100, Void_POS_ID: 3, Line_Amount: "-7.00" }),
      li({ xfer: "1" }, { Guest_Num: 2, Parent_LineItem_ID: 3, Parent_Tray_Number: 1, Quantity: 1, Line_Number: 2, MenuItem_POS_ID: 300, Line_Amount: "-9.00" }),
      li({ xfer: "1" }, { Guest_Num: 2, Parent_LineItem_ID: 4, Parent_Tray_Number: 1, Quantity: 1, Line_Number: 3, MenuItem_POS_ID: 301, Line_Amount: "0.00" }),
      li({ type: "T" }, { Quantity: 1, Line_Number: 4, Tender_POS_ID: 7, Line_Amount: "1.00" }),
    ] },
  ] };
  const { lines, tenders } = parseCheckLines(fc, names);

  it("drops the markers themselves and the originals that left; strikes voided originals", () => {
    expect(lines.filter((l) => l.transferOut || (l.isVoid && l.amount < 0))).toHaveLength(0);
    expect(lines.find((l) => l.menuItemId === "300")).toBeUndefined();        // transferred out
    expect(lines.find((l) => l.menuItemId === "301")).toBeUndefined();        // its modifier too
    const voided = lines.find((l) => l.menuItemId === "100")!;
    expect(voided.isVoid).toBe(true);                                           // struck, no value
    expect(checkSubtotal({ ...newCheck("1"), lines })).toBe(3 - 2);            // 200 ($3) + adjustment (−$2)
  });
  it("restores Type A / R, Is_Held, applied_to_guests and server identity", () => {
    const adj = lines.find((l) => l.kind === "A")!;
    expect([adj.adjustmentId, adj.description, adj.amount]).toEqual(["55", "ADJ 55", -2]);
    const ref = lines.find((l) => l.kind === "R")!;
    expect(ref.reference).toBe("NOTSHOWN:GuestCount::2");
    expect(lines.some((l) => l.kind === "M" && l.menuItemId === "")).toBe(false); // no '#' items
    const wt = lines.find((l) => l.menuItemId === "200")!;
    expect([wt.held, wt.appliedToGuests, wt.trayNumber, wt.lineNumber, wt.sent]).toEqual([true, "0", 1, 2, true]);
    expect(tenders).toHaveLength(1);
  });
});

describe("block B — quantity, fractional split, refire chit", () => {
  it("setQuantity scales the modifiers with the parent (priced mod extends)", async () => {
    const { setQuantity, lineExtended } = await import("@/model/check");
    let c = newCheck("1"); c = addItemLine(c, item("100", 20), "a", 1); c = addModifierLine(c, "a", item("bp", 7), 7);
    c = setQuantity(c, "a", 2);
    expect(c.lines.map((l) => l.quantity)).toEqual([2, 2]);
    expect(lineExtended(c.lines[1])).toBe(14);
    expect(checkSubtotal(c)).toBe(54);
  });
  it("splitItemAmongGuests: portions sum exactly, last guest takes the remainder, sent original retired by an Is_Split marker", async () => {
    const { splitItemAmongGuests } = await import("@/model/check");
    let c = newCheck("1", "", 3); c = addItemLine(c, item("100", 7.25), "a", 1); c = addModifierLine(c, "a", item("m", 0), 0); c = markRoundSent(c);
    c = splitItemAmongGuests(c, new Set(["a"]), [1, 2, 3], "9");
    const portions = c.lines.filter((l) => !l.sent && !l.isSplit && l.kind === "M");
    expect(portions.map((l) => l.guestNumber)).toEqual([1, 2, 3]);
    const exts = portions.map((l) => Math.round(l.amount * l.quantity * 100) / 100);
    expect(exts).toEqual([2.42, 2.42, 2.41]);
    expect(exts.reduce((a, b) => a + b, 0)).toBeCloseTo(7.25, 2);
    expect(c.lines.filter((l) => l.kind === "Mo" && !l.sent && !l.isSplit)).toHaveLength(3); // modifier follows each portion
    const markers = c.lines.filter((l) => l.isSplit);
    expect(markers.map((l) => [l.amount, l.parentTrayNumber, l.parentLineNumber])).toEqual([[-7.25, 1, 1], [-0, 1, 2]]);
    expect(checkSubtotal(c)).toBeCloseTo(7.25, 2);                                       // struck original + portions = same total
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toMatch(/Is_Split="1"[^>]*>.*?<Parent_LineItem_ID>1<\/Parent_LineItem_ID><Parent_Tray_Number>1<\/Parent_Tray_Number>/);
  });
  it("refire chit leads with a red centered Refire line", async () => {
    const { buildPrepChit } = await import("@/protocol/printjobs");
    const s = buildPrepChit("Kitchen", { checkNo: "1", server: "A B", guests: 1, rcName: "R", tabLabel: "TBL: 1", date: "d", time: "t", refire: true }, [{ qty: 1, name: "Wings", mods: [] }], 32);
    expect(s.indexOf("Refire")).toBeGreaterThan(0);
    expect(s.indexOf("Refire")).toBeLessThan(s.indexOf("Kitchen"));
    expect(s).toContain("\x1br\x01Refire");
  });
});
