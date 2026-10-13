/*
 * Coursing (COURSING_SPEC.md): course on the line, the wire round trip
 * (print_Sort_Order), Fire Course records, prep-chit course headers, the
 * fire chit, and the KDS JSON course/fired/fire keys.
 */

import { describe, expect, it } from "vitest";
import { absorbSentLines, addFireCourseRecord, addItemLine, effectiveCourse, firedCourses, lastLineOf, markRoundSent, repeatLastOf, setCourse, setLineReference, unsentLines, type Check, type CheckLine } from "@/model/check";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";
import { parseCheckLines } from "@/protocol/tables";
import { buildFireChit, buildPrepChit, courseHeaderText, courseRuns, type CourseOpts, type PrepCtx, type PrepItem } from "@/protocol/printjobs";
import { buildKdsOrderJson } from "@/protocol/kdsorder";

const line = (key: string, o: Partial<CheckLine> = {}): CheckLine =>
  ({ key, menuItemId: "7", description: key, amount: 10, quantity: 1, kind: "M", indentLevel: 0, guestNumber: 1, ...o });
const check = (lines: CheckLine[]): Check =>
  ({ id: "C", revenueCenterId: "1", tableName: "", guestCount: 2, lines, tenders: [], traysSent: 0, openedAt: 0 });
const ctx: SendContext = { isisVer: "1", storeId: "997", securityToken: "t", terminalPosId: "58", employeePosId: "1", businessDateId: "9", checkNo: "5" };

describe("course on the line", () => {
  it("override wins over the item default; no default → 0", () => {
    expect(effectiveCourse(line("a"), 3)).toBe(3);
    expect(effectiveCourse(line("a", { course: 1 }), 3)).toBe(1);
    expect(effectiveCourse(line("a", { course: 0 }), 3)).toBe(0);
    expect(effectiveCourse(line("a"), 0)).toBe(0);
  });
  it("setCourse stamps selected menu items only; modifiers follow their parent", () => {
    const c = setCourse(check([line("a"), line("m", { kind: "Mo", parentKey: "a", indentLevel: 1 }), line("b")]), new Set(["a", "m"]), 2);
    expect(c.lines.map((l) => l.course)).toEqual([2, undefined, undefined]);
  });
  it("Fire Course adds a shown note and a firecourse record that reads back", () => {
    const c = addFireCourseRecord(check([line("a", { course: 2, sent: true })]), 2, "33", new Date(2026, 9, 8, 18, 5));
    const refs = c.lines.filter((l) => l.kind === "R");
    expect(refs[0].reference).toBe("FIRE COURSE 2");
    expect(JSON.parse(refs[1].reference!)).toEqual({ type: "firecourse", course: 2, time: "2026-10-08 18:05", src: "pos" });
    expect(refs[1].authEmpId).toBe("33");
    expect([...firedCourses(c)]).toEqual([2]);
  });
});

describe("wire: print_Sort_Order", () => {
  it("is emitted for an item with a course, and a modifier rides its parent's", () => {
    const xml = buildFinancialCheck(check([line("a", { course: 3 }), line("m", { kind: "Mo", parentKey: "a", indentLevel: 1 }), line("b")]), ctx);
    expect(xml.match(/<print_Sort_Order>3<\/print_Sort_Order>/g)).toHaveLength(2);
    expect(xml.split("<LineItem ")[3]).not.toContain("print_Sort_Order"); // "b" has none
  });
  it("reads back into course on the item line", () => {
    const li = (n: number, extra: Record<string, string>) => ({ Type: "M", Is_Void: "0", Transfered_Out: "0", Is_Split: "0", Is_Held: "0",
      Line_Number: String(n), Quantity: "1", Line_Amount: "10.00", Guest_Num: "1", MenuItem_POS_ID: "7", ...extra });
    const dict = { Tray: { Tray_Number: "1", LineItem: [li(1, { print_Sort_Order: "4" }), li(2, {})] } };
    const { lines } = parseCheckLines(dict as never, { menuItemName: () => "x", tenderName: () => "t" });
    expect(lines.map((l) => l.course)).toEqual([4, undefined]);
  });
});

const pctx: PrepCtx = { checkNo: "5", server: "Ann Lee", guests: 2, rcName: "Dining", tabLabel: "TBL: 4", date: "2026-10-08", time: "6:05" };
const opts: CourseOpts = { useCourse: true, forceHeaders: false, names: ["Apps", "", "", "", "", "", "", "", "", ""], red: false, guestBeforeCourse: false };
const it_ = (name: string, course?: number, guest = 1): PrepItem => ({ qty: 1, name, mods: [], course, guest });

describe("prep chit course headers (PrintManager rules)", () => {
  it("groups 1..10 then Others; missing course prints as 6; names fall back to Course N", () => {
    // an uncoursed item (Bread) turns headers off unless the store forces them (print_Course_Line)
    const runs = courseRuns([it_("Steak", 2), it_("Soup", 1), it_("Bread", 0), it_("Mystery")], { ...opts, forceHeaders: true });
    expect(runs.map((r) => [r.header, r.items.map((i) => i.name)])).toEqual([
      ["Apps", ["Soup"]], ["Course 2", ["Steak"]], ["Course 6", ["Mystery"]], ["Others", ["Bread"]],
    ]);
  });
  it("no headers unless the printer uses courses and (every item is coursed or the store forces it)", () => {
    expect(courseRuns([it_("Soup", 1), it_("Bread", 0)], opts)[0].header).toBe("");
    expect(courseRuns([it_("Soup", 1), it_("Bread", 0)], { ...opts, forceHeaders: true }).map((r) => r.header)).toEqual(["Apps", "Others"]);
    expect(courseRuns([it_("Soup", 1)], { ...opts, useCourse: false })[0].header).toBe("");
  });
  it("guest before course groups by guest first", () => {
    const runs = courseRuns([it_("Steak", 2, 1), it_("Soup", 1, 2), it_("Fish", 2, 2)], { ...opts, guestBeforeCourse: true });
    expect(runs.map((r) => [r.header, r.items.map((i) => i.name)])).toEqual([["Course 2", ["Steak"]], ["Apps", ["Soup"]], ["Course 2", ["Fish"]]]);
  });
  it("renders the header centered between asterisks, red when asked, and held items stay off", () => {
    expect(courseHeaderText("Apps", 21)).toBe("***** Apps *****");
    const job = buildPrepChit("Grill", pctx, [it_("Steak", 2), { ...it_("Fries", 2), held: true }], 40, { ...opts, red: true });
    expect(job).toContain("Course 2");
    expect(job).toContain("\x1br\x01"); // red on for the header
    expect(job).toContain("Steak");
    expect(job).not.toContain("Fries");
  });
  it("fire chit names the course and lists only its items", () => {
    const job = buildFireChit("Grill", pctx, 2, "Mains", [it_("Steak", 2)], 40);
    expect(job).toContain("FIRE COURSE 2");
    expect(job).toContain("Mains");
    expect(job).toContain("Steak");
  });
});

describe("KDS JSON coursing keys (optional, absent by default)", () => {
  const base = { token: "t", entid: "1", entcode: "ENOX", server: "Ann", empId: "1", guests: 2, checkNo: "5", date: "d", revenueCenter: "Dining", tableName: "Table 4", store: "997", printerId: "9", bdid: "9", checkKey: "C", togo: "", vip: "", allergy: "0" };
  const li = { lineitemkey: "C:a", quantity: "1", description: "Steak", amount: "10.00", guestNumber: "1", indentLevel: 0, reference: "", type: "M", isVoid: "0" };
  it("emits course/fired/fire only when set", () => {
    const plain = JSON.parse(buildKdsOrderJson("u", base, [li], { tax: "0", total: "10" }));
    expect(plain.check.lineitem[0]).not.toHaveProperty("course");
    expect(plain.check.lineitem[0]).not.toHaveProperty("fired");
    expect(plain.check.header).not.toHaveProperty("fire");
    const held = JSON.parse(buildKdsOrderJson("u", { ...base, fire: "2" }, [{ ...li, course: "2", fired: "0" }], { tax: "0", total: "10" }));
    expect(held.check.lineitem[0].course).toBe("2");
    expect(held.check.lineitem[0].fired).toBe("0");
    expect(held.check.header.fire).toBe("2");
  });
});

describe("markRoundSent keeps the course", () => {
  it("course survives the send stamp", () => {
    const c = markRoundSent(check([line("a", { course: 2 })]));
    expect(c.lines[0].course).toBe(2);
    expect(c.lines[0].sent).toBe(true);
  });
});

describe("long-press ring options", () => {
  it("addItemLine can place a held line (Hold pill) and markRoundSent leaves it off the fire list", () => {
    const c = check([]);
    const mi = { id: "7", name: "Steak", price: "10.00", modChainId: "" } as unknown as import("@/model/catalog").MenuItem;
    const placed = addItemLine(c, mi, "k1", 1, undefined, 2, true);
    expect(placed.lines[0].held).toBe(true);
    expect(placed.lines[0].course).toBe(2);
    expect(unsentLines(placed).length).toBe(1);
  });
});

describe("medium pills: repeat last, item note", () => {
  it("repeatLastOf copies the latest family unsent with a fresh key; note rides the Reference element", () => {
    const sent = markRoundSent(check([line("a", { course: 2, reference: "Gluten" }), line("m", { kind: "Mo", parentKey: "a", indentLevel: 1 })]));
    const { check: again, key } = repeatLastOf(sent, "7", 123);
    expect(key).toBeDefined();
    const fresh = again.lines.filter((l) => !l.sent);
    expect(fresh.map((l) => [l.kind, l.course, l.reference, l.rungAt])).toEqual([["M", 2, "Gluten", 123], ["Mo", undefined, undefined, 123]]);
    expect(fresh[1].parentKey).toBe(key);
    const xml = buildFinancialCheck(again, ctx);
    expect(xml).toContain("<Reference>Gluten</Reference>");
    expect(lastLineOf(again, "7")!.key).toBe(key);
    expect(setLineReference(again, key!, "  ").lines.find((l) => l.key === key)!.reference).toBeUndefined();
  });
  it("the chit prints the note under the item", () => {
    const job = buildPrepChit("Grill", pctx, [{ qty: 1, name: "Steak", mods: ["Rare"], note: "Gluten · no bun" }], 40);
    expect(job).toContain("   - Rare");
    expect(job).toContain("   * Gluten · no bun");
  });
});

describe("fire now: absorbSentLines", () => {
  it("marks only the fired family sent and leaves the other unsent lines alone", () => {
    const c = check([line("sentA", { sent: true, trayNumber: 1, lineNumber: 1 }), line("fire"), line("fireMod", { kind: "Mo", parentKey: "fire", indentLevel: 1 }), line("later")]);
    const fam = new Set(["fire", "fireMod"]);
    const subset: Check = { ...c, checkNumber: "5", lines: c.lines.filter((l) => l.sent || fam.has(l.key)) };
    const stamped = markRoundSent(subset);
    const out = absorbSentLines(c, stamped, fam);
    expect(out.lines.map((l) => [l.key, !!l.sent, l.trayNumber])).toEqual([["sentA", true, 1], ["fire", true, 1], ["fireMod", true, 1], ["later", false, undefined]]);
    expect(out.traysSent).toBe(1);
    expect(out.checkNumber).toBe("5");
  });
});

describe("P13 / O15: tax exemption read-back and ChangeRVC record", () => {
  it("parseExemptTaxGroups reads Is_Exempt=1 report groups off Tax_Group_Amt", async () => {
    const { parseExemptTaxGroups } = await import("@/protocol/tables");
    const dict = { Tax_Group_Amt: [
      { Tax_Report_Group_POS_ID: { Is_Exempt: "1", _text: "2" }, Tax_Amount: "0.00" },
      { Tax_Report_Group_POS_ID: { Is_Exempt: "0", _text: "3" }, Tax_Amount: "1.44" },
      { Tax_Report_Group_POS_ID: "1", Tax_Amount: "0.14" },
    ] };
    expect(parseExemptTaxGroups(dict as never)).toEqual(["2"]);
    expect(parseExemptTaxGroups({} as never)).toEqual([]);
  });
  it("changeRevenueCenter switches the RC and adds the hidden ChangeRVC record", async () => {
    const { changeRevenueCenter } = await import("@/model/check");
    const c = { ...check([line("a", { sent: true })]), checkNumber: "210010", revenueCenterId: "1" };
    const out = changeRevenueCenter(c, { id: "4", name: "Pool" }, "Restaurant", "33", "9999", new Date(2026, 9, 13, 12, 5));
    expect(out.revenueCenterId).toBe("4");
    const rec = out.lines.find((l) => l.kind === "R")!;
    expect(JSON.parse(rec.reference!)).toEqual({ type: "ChangeRVC", chk: 210010, oldRVC: "Restaurant", newRVC: "Pool", emp: 33, time: "2026-10-13 12:05" });
    expect(rec.authEmpId).toBe("9999");
    expect(rec.sent).toBeUndefined();
    expect(changeRevenueCenter(out, { id: "4", name: "Pool" }, "Pool", "33")).toBe(out); // same RC → no-op
  });
});
