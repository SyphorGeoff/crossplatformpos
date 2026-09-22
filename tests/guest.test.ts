/*
 * Order-by-guest — guest assignment from the selected guest, the Type="R"
 * reference-line substrate (shown / NOTSHOWN / common-schema), the display
 * filter, guest-number remap, and the guest sort. Faithful to the iPad
 * (FinancialCheckManager.m guest block :439-444, R builders :18649-18774,
 * display filter :16752-16754, compareLineItemsByGuest :312-348).
 */

import { describe, expect, it } from "vitest";
import {
  addCommonSchemaRef, addGuestNote, addItemLine, addModifierLine, addNotShownRef, addShownRef,
  guestAssignment, highestGuestNumber, newCheck, refIsShown, setLineGuest, sortLinesByGuest, type Check,
} from "@/model/check";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";

const item = (id: string, price = 10) => ({ id, name: `item ${id}`, price: String(price) } as any);
const ctx: SendContext = {
  isisVer: "1", storeId: "3", securityToken: "T", terminalPosId: "20",
  employeePosId: "1", businessDateId: "9", checkNo: "200001",
};

describe("guestAssignment (currentGuestIndex → Guest_Num)", () => {
  it("maps a 0-based guest index to Guest_Num = index + 1", () => {
    expect(guestAssignment(0)).toEqual({ guestNumber: 1 });
    expect(guestAssignment(3)).toEqual({ guestNumber: 4 });
  });
  it("maps the 'T' tile (-1) to whole-table: guest 1 + applied_to_guests='0'", () => {
    expect(guestAssignment(-1)).toEqual({ guestNumber: 1, appliedToGuests: "0" });
  });
});

describe("item + modifier guest inheritance", () => {
  it("assigns the item its guest and the modifier inherits it", () => {
    let c = newCheck("1");
    const { guestNumber, appliedToGuests } = guestAssignment(2); // guest 3
    c = addItemLine(c, item("100"), "a", guestNumber, appliedToGuests);
    c = addModifierLine(c, "a", item("999", 0), 0);
    expect(c.lines[0].guestNumber).toBe(3);
    expect(c.lines[1].kind).toBe("Mo");
    expect(c.lines[1].guestNumber).toBe(3); // modifier follows its parent
  });
  it("whole-table item and its modifier both carry applied_to_guests='0'", () => {
    let c = newCheck("1");
    const g = guestAssignment(-1);
    c = addItemLine(c, item("100"), "a", g.guestNumber, g.appliedToGuests);
    c = addModifierLine(c, "a", item("999", 0), 0);
    expect(c.lines[0].appliedToGuests).toBe("0");
    expect(c.lines[1].appliedToGuests).toBe("0");
  });
});

describe("Type=R reference lines + display filter", () => {
  it("addShownRef shows on the check", () => {
    const c = addShownRef(newCheck("1"), "VIP guest");
    const r = c.lines[0];
    expect(r.kind).toBe("R");
    expect(r.reference).toBe("VIP guest");
    expect(refIsShown(r)).toBe(true);
  });
  it("addGuestNote is shown and tied to a guest", () => {
    const c = addGuestNote(newCheck("1"), 2, "no peanuts");
    expect(refIsShown(c.lines[0])).toBe(true);
    expect(c.lines[0].guestNumber).toBe(2);
  });
  it("addNotShownRef is hidden (NOTSHOWN prefix)", () => {
    const c = addNotShownRef(newCheck("1"), "GuestCount::4");
    expect(c.lines[0].reference).toBe("NOTSHOWN:GuestCount::4");
    expect(refIsShown(c.lines[0])).toBe(false);
  });
  it("addCommonSchemaRef is hidden (JSON + AuthorizingEmployee_ID)", () => {
    const c = addCommonSchemaRef(newCheck("1"), { type: "chkxfer", fromempid: 1, toempid: 2 }, "9999");
    const r = c.lines[0];
    expect(JSON.parse(r.reference!).type).toBe("chkxfer");
    expect(r.authEmpId).toBe("9999");
    expect(refIsShown(r)).toBe(false);
  });
});

describe("setLineGuest (change guest)", () => {
  it("reassigns a line to a numbered guest and clears the whole-table marker", () => {
    let c = newCheck("1");
    c = addItemLine(c, item("100"), "a", 1, "0"); // was whole-table
    c = setLineGuest(c, new Set(["a"]), 3);
    expect(c.lines[0].guestNumber).toBe(3);
    expect(c.lines[0].appliedToGuests).toBeUndefined();
  });
  it("guest 0 sets only applied_to_guests='0' (whole table), keeping Guest_Num", () => {
    let c = newCheck("1");
    c = addItemLine(c, item("100"), "a", 2);
    c = setLineGuest(c, new Set(["a"]), 0);
    expect(c.lines[0].guestNumber).toBe(2);
    expect(c.lines[0].appliedToGuests).toBe("0");
  });
  it("carries a selected item's modifiers with it", () => {
    let c = newCheck("1");
    c = addItemLine(c, item("100"), "a", 1);
    c = addModifierLine(c, "a", item("999", 0), 0);
    c = setLineGuest(c, new Set(["a"]), 4);
    expect(c.lines[0].guestNumber).toBe(4);
    expect(c.lines[1].guestNumber).toBe(4); // modifier moved too
  });
});

describe("highestGuestNumber + sortLinesByGuest", () => {
  const build = (): Check => {
    let c = newCheck("1"); c.guestCount = 2;
    c = addItemLine(c, item("A"), "g2", 2);
    c = addItemLine(c, item("W"), "wt", 1, "0"); c.lines[1].guestNumber = 0; // whole table
    c = addItemLine(c, item("B"), "g1", 1);
    c = addModifierLine(c, "g1", item("mod", 0), 0);
    return c;
  };
  it("renders at least the guest count, growing with the highest guest used", () => {
    let c = newCheck("1"); c.guestCount = 3;
    c = addItemLine(c, item("A"), "a", 5); // guest 5 > count
    expect(highestGuestNumber(c)).toBe(5);
  });
  it("sorts whole-table (0) first, then by guest, keeping modifiers with parents", () => {
    const c = build();
    const order = sortLinesByGuest(c.lines).map((l) => l.description);
    // whole-table item, then guest-1 item + its modifier, then guest-2 item
    expect(order).toEqual(["item W", "item B", "item mod", "item A"]);
  });
});

describe("wire emission (Guest_Num / applied_to_guests / Reference / Type=R)", () => {
  it("emits Guest_Num and applied_to_guests on a whole-table item", () => {
    let c = newCheck("1");
    c = addItemLine(c, item("100"), "a", 1, "0");
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<Guest_Num>1</Guest_Num>");
    expect(xml).toContain("<applied_to_guests>0</applied_to_guests>");
  });
  it("emits a Type=R reference line with its Reference and no menu/price", () => {
    let c = newCheck("1");
    c = addShownRef(c, "table note");
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain('Type="R"');
    expect(xml).toContain("<Reference>table note</Reference>");
    expect(xml).toContain('Print_On_Check="0" Show_On_Display="0" Type="R"'); // non-printing, non-display
    expect(xml).not.toContain("<MenuItem_POS_ID></MenuItem_POS_ID>"); // no menu item on a ref line
  });
  it("a common-schema ref rides AuthorizingEmployee_ID", () => {
    let c = newCheck("1");
    c = addCommonSchemaRef(c, { type: "chksplit" }, "9999");
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<AuthorizingEmployee_ID>9999</AuthorizingEmployee_ID>");
  });
});
