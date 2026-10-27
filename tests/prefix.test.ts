/*
 * Menu-item prefixes (CUP / BOWL x1.4 / No…) — the ToppingPrefix port. Locks the bar order,
 * the pricing modes, the wire Quantity, the line chip cycling, and the pull-back.
 */

import { describe, expect, it } from "vitest";
import { addItemLine, addModifierLine, markRoundSent, newCheck, type Check } from "@/model/check";
import { ancestorMultipliers, defaultPrefixOf, nextPrefix, prefixedName, prefixedUnitPrice, prefixesForGroup, setLinePrefix, wireQuantity, type PrefixDefs } from "@/model/prefix";
import type { MenuItem, ToppingPrefix } from "@/model/catalog";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";
import { parseCheckLines } from "@/protocol/tables";
import type { XmlDict } from "@/protocol/hbroker";

// enox store 3 as served 2026-10-26: group 1 "CUP or BOWL" (default 3 CUP; BOWL x1.4 = 4, price ×1.4)
const tp = (id: string, name: string, inv = 1, price = 1, mode: 0 | 1 | 2 = 0): ToppingPrefix =>
  ({ id, name, inventoryMultiplier: inv, priceMultiplier: price, mode, screenChainId: "", _raw: {} });
const CUP = tp("3", "CUP"), BOWL = tp("4", "BOWL x1.4", 1, 1.4), NO = tp("7", "No", 0, 1), DBL = tp("8", "Dbl"), EASY = tp("9", "Easy");
const PLUS2 = tp("20", "+$2", 1, 2, 1), HH = tp("21", "HH", 1, 2, 2), T3 = tp("22", "Tier3", 1, 3, 2);
const defs: PrefixDefs = {
  prefixById: new Map([CUP, BOWL, NO, DBL, EASY, PLUS2, HH, T3].map((p) => [p.id, p])),
  toppingGroupById: new Map([
    ["1", { id: "1", name: "CUP or BOWL", defaultPrefixId: "3", _raw: {} }],
    ["3", { id: "3", name: "Reg Mod", defaultPrefixId: "", _raw: {} }],
  ]),
  toppingGroupPrefixes: [{ prefixId: "4", groupId: "1" }, { prefixId: "3", groupId: "1" }, { prefixId: "8", groupId: "3" }, { prefixId: "7", groupId: "3" }, { prefixId: "9", groupId: "3" }],
};
const soup = { id: "55563", name: "Cup Tomato Soup", price: "5.00", isTimedItem: false, _raw: { Happy_Hour_Price: "4.25", Price_Tier_3: "" } } as unknown as MenuItem;

describe("prefixesForGroup (ItemsTableViewController :1284-1330)", () => {
  it("default first, the rest by InventoryMultiplier; the default is not repeated", () => {
    expect(prefixesForGroup(defs, "1").map((p) => p.name)).toEqual(["CUP", "BOWL x1.4"]);
    expect(prefixesForGroup(defs, "3").map((p) => p.name)).toEqual(["No", "Dbl", "Easy"]);   // No (0) sorts ahead
    expect(prefixesForGroup(defs, "9")).toEqual([]);
    expect(defaultPrefixOf(defs, "1")?.name).toBe("CUP");
    expect(defaultPrefixOf(defs, "3")).toBeUndefined();
  });
});

describe("prefixedUnitPrice (FinancialCheckManager :8838-8960)", () => {
  it("mode 0 scales the price; mode 1 adds dollars; mode 2 picks a tier (base when the tier is empty); $0 stays $0", () => {
    expect(prefixedUnitPrice(5, BOWL, soup)).toBe(7);
    expect(prefixedUnitPrice(5, CUP, soup)).toBe(5);
    expect(prefixedUnitPrice(5, PLUS2, soup)).toBe(7);
    expect(prefixedUnitPrice(5, HH, soup)).toBe(4.25);
    expect(prefixedUnitPrice(5, T3, soup)).toBe(5);
    expect(prefixedUnitPrice(0, BOWL, soup)).toBe(0);
    expect(prefixedUnitPrice(5, undefined, soup)).toBe(5);
    expect(prefixedUnitPrice(3.33, BOWL, soup)).toBe(4.66);
  });
});

describe("wireQuantity", () => {
  it("count × InventoryMultiplier: int when whole, one decimal when exact, else two", () => {
    expect(wireQuantity(2, 1)).toBe("2");
    expect(wireQuantity(1, 0)).toBe("0");
    expect(wireQuantity(1, 1.5)).toBe("1.5");
    expect(wireQuantity(1, 0.25)).toBe("0.25");
  });
});

describe("setLinePrefix / nextPrefix (the line chip)", () => {
  it("stamps prefix + pfix + multiplier and re-prices from the base price; cycling returns to the base", () => {
    let c = addItemLine(newCheck("3"), soup, "a", 1);
    c = setLinePrefix(c, "a", BOWL, soup);
    expect(c.lines[0]).toMatchObject({ prefixId: "4", pfix: "BOWL x1.4", prefixQtyMult: 1, amount: 7, baseAmount: 5 });
    const list = prefixesForGroup(defs, "1");
    expect(nextPrefix(list, "4")?.name).toBe("CUP");
    expect(nextPrefix(list, undefined)?.name).toBe("CUP");    // no prefix yet → the first
    expect(nextPrefix(list, "99")?.name).toBe("CUP");         // a prefix outside the group → restart
    expect(nextPrefix([], "4")).toBeUndefined();
    c = setLinePrefix(c, "a", CUP, soup);
    expect(c.lines[0]).toMatchObject({ prefixId: "3", pfix: "CUP", amount: 5 });
    c = setLinePrefix(c, "a", undefined, soup);
    expect(c.lines[0].prefixId).toBeUndefined();
    expect(c.lines[0].amount).toBe(5);
  });
  it("leaves a sent line alone", () => {
    let c = markRoundSent(addItemLine(newCheck("3"), soup, "a", 1));
    c = setLinePrefix(c, "a", BOWL, soup);
    expect(c.lines[0].prefixId).toBeUndefined();
    expect(c.lines[0].amount).toBe(5);
  });
});

describe("modifier under a prefixed item (getParentPriceMultipler / getParentQtyMultipler)", () => {
  const DBL = tp("11", "DBL x1.4", 1, 1.6), HALF = tp("30", "Half", 0.5, 1);
  const d2: PrefixDefs = { ...defs, prefixById: new Map([...defs.prefixById, [DBL.id, DBL], [HALF.id, HALF]]) };
  const cheese = { id: "900", name: "Add Cheese", price: "1.00", _raw: {} } as unknown as MenuItem;
  it("a plain modifier takes the parent's plain price multiplier; a prefixed one multiplies both; $0 stays $0", () => {
    let c = setLinePrefix(addItemLine(newCheck("3"), soup, "a", 1), "a", BOWL, soup);   // BOWL ×1.4
    c = addModifierLine(c, "a", cheese, 1, 1, "m1");
    c = addModifierLine(c, "a", cheese, 1, 1, "m2");
    c = addModifierLine(c, "a", cheese, 0, 1, "m3");
    expect(ancestorMultipliers(c.lines, "a", d2)).toEqual({ price: 1.4, qty: 1 });
    c = setLinePrefix(c, "m1", undefined, cheese, d2);
    c = setLinePrefix(c, "m2", DBL, cheese, d2);
    c = setLinePrefix(c, "m3", DBL, cheese, d2);
    expect(c.lines.find((l) => l.key === "m1")).toMatchObject({ amount: 1.4, baseAmount: 1 });
    expect(c.lines.find((l) => l.key === "m1")!.prefixId).toBeUndefined();
    expect(c.lines.find((l) => l.key === "m2")).toMatchObject({ amount: 2.24, prefixId: "11", pfix: "DBL x1.4", prefixQtyMult: 1 });
    expect(c.lines.find((l) => l.key === "m3")!.amount).toBe(0);
  });
  it("quantity factors compound down the chain and a fixed-dollar / tier parent does not scale the price", () => {
    let c = setLinePrefix(addItemLine(newCheck("3"), soup, "a", 1), "a", HALF, soup);   // inv ×0.5, price ×1
    c = addModifierLine(c, "a", cheese, 1, 1, "m1");
    c = setLinePrefix(c, "m1", HALF, cheese, d2);
    expect(c.lines.find((l) => l.key === "m1")).toMatchObject({ amount: 1, prefixQtyMult: 0.25 });
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<Quantity>0.5</Quantity>");
    expect(xml).toContain("<Quantity>0.25</Quantity>");
    let f = setLinePrefix(addItemLine(newCheck("3"), soup, "b", 1), "b", PLUS2, soup);  // +$2 → mods unscaled
    f = addModifierLine(f, "b", cheese, 1, 1, "m2");
    f = setLinePrefix(f, "m2", undefined, cheese, d2);
    expect(f.lines.find((l) => l.key === "m2")!.amount).toBe(1);
  });
});

describe("prefixedName (chit / KDS)", () => {
  it("first three letters padded to four, ahead of the name", () => {
    expect(prefixedName("BOWL x1.4", "Cup Tomato Soup")).toBe("BOW Cup Tomato Soup");
    expect(prefixedName("No", "Onions")).toBe("No  Onions");
    expect(prefixedName(undefined, "Onions")).toBe("Onions");
  });
});

const ctx: SendContext = { isisVer: "1", storeId: "3", securityToken: "T", terminalPosId: "20", employeePosId: "1", businessDateId: "9", checkNo: "200001" };

describe("wire (lineItemtoString :12380-12385)", () => {
  it("emits toppingPrefix_ID + pfix, Quantity × InventoryMultiplier, Line_Amount from the prefixed unit", () => {
    let c: Check = addItemLine(newCheck("3"), soup, "a", 1);
    c = setLinePrefix(c, "a", BOWL, soup);
    c = { ...c, lines: c.lines.map((l) => ({ ...l, quantity: 2 })) };
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<Quantity>2</Quantity>");
    expect(xml).toContain("<toppingPrefix_ID>4</toppingPrefix_ID><pfix>BOWL x1.4</pfix><Line_Amount>14.00</Line_Amount>");
    const no = setLinePrefix(addItemLine(newCheck("3"), soup, "b", 1), "b", NO, soup);
    expect(buildFinancialCheck(no, ctx)).toContain("<Quantity>0</Quantity>");
  });
  it("a plain line carries no prefix elements", () => {
    expect(buildFinancialCheck(addItemLine(newCheck("3"), soup, "a", 1), ctx)).not.toContain("toppingPrefix_ID");
  });
});

describe("pull-back (parsePullBackCheck :6458-6480 + CheckTableCellView :397-425)", () => {
  const li = (kids: Record<string, string | number>): XmlDict => ({
    Is_Held: "0", Is_Void: "0", Transfered_Out: "0", Print_On_Check: "1", Show_On_Display: "1", Type: "M", Finalized: "0", Is_Split: "0", lineitemkey: "1", posted: "1",
    ...Object.fromEntries(Object.entries(kids).map(([k, v]) => [k, String(v)])),
  });
  const names = {
    menuItemName: (id: string) => `MI ${id}`, tenderName: (id: string) => `T ${id}`,
    prefixQtyMult: (id: string) => defs.prefixById.get(id)?.inventoryMultiplier, prefixName: (id: string) => defs.prefixById.get(id)?.name,
  };
  it("restores the prefix and divides the wire Quantity back to a count", () => {
    const fc: XmlDict = { Tray: [{ Tray_Number: "1", Sent_On: "2026-10-26 12:00:00", LineItem: [
      li({ Guest_Num: 1, Quantity: 1, Line_Number: 1, MenuItem_POS_ID: 55563, toppingPrefix_ID: 4, pfix: "BOWL x1.4", Line_Amount: "7.00" }),
      li({ Guest_Num: 1, Quantity: "3", Line_Number: 2, MenuItem_POS_ID: 55563, toppingPrefix_ID: 99, Line_Amount: "15.00" }),  // unknown prefix: multiplier 1
      li({ Guest_Num: 1, Quantity: 1, Line_Number: 3, MenuItem_POS_ID: 1, Line_Amount: "2.00" }),
    ] }] };
    const { lines } = parseCheckLines(fc, names);
    expect(lines[0]).toMatchObject({ prefixId: "4", pfix: "BOWL x1.4", prefixQtyMult: 1, quantity: 1, amount: 7 });
    expect(lines[1]).toMatchObject({ prefixId: "99", pfix: "", prefixQtyMult: 1, quantity: 3, amount: 5 });
    expect(lines[2].prefixId).toBeUndefined();
  });
  it("a modifier's wire quantity is divided by its own and its parent's factors", () => {
    const half = { ...defs, prefixById: new Map([...defs.prefixById, ["30", tp("30", "Half", 0.5, 1)]]) };
    const n2 = { ...names, prefixQtyMult: (id: string) => half.prefixById.get(id)?.inventoryMultiplier, prefixName: (id: string) => half.prefixById.get(id)?.name };
    const fc: XmlDict = { Tray: [{ Tray_Number: "1", Sent_On: "2026-10-26 12:00:00", LineItem: [
      li({ Guest_Num: 1, Quantity: "0.5", Line_Number: 1, MenuItem_POS_ID: 55563, toppingPrefix_ID: 30, pfix: "Half", Line_Amount: "5.00" }),
      li({ Guest_Num: 1, Parent_LineItem_ID: 1, Parent_Tray_Number: 1, Quantity: "0.25", Line_Number: 2, MenuItem_POS_ID: 900, toppingPrefix_ID: 30, pfix: "Half", Line_Amount: "1.00" }),
      li({ Guest_Num: 1, Parent_LineItem_ID: 1, Parent_Tray_Number: 1, Quantity: "0.5", Line_Number: 3, MenuItem_POS_ID: 901, Line_Amount: "2.00" }),
    ] }] };
    const { lines } = parseCheckLines(fc, n2);
    expect(lines[0]).toMatchObject({ quantity: 1, amount: 5, prefixQtyMult: 0.5 });
    expect(lines[1]).toMatchObject({ kind: "Mo", quantity: 1, amount: 1, prefixQtyMult: 0.25, pfix: "Half" });
    expect(lines[2]).toMatchObject({ kind: "Mo", quantity: 1, amount: 2, prefixQtyMult: 0.5 });
    expect(lines[2].prefixId).toBeUndefined();
  });
});
