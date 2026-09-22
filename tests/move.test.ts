/*
 * Moving lines between checks — the shared core for Split Guest / Transfer Item /
 * Merge, faithful to FinancialCheckManager.m (addnewLineItems / addSplitCheck-
 * NewLineItems :10500-10700; voidLineItems isTransferItems :1946-1952) and the
 * FinancialCheck wire flags (Is_Closed / Is_Transferred / Employee_POS_ID owner).
 */

import { describe, expect, it } from "vitest";
import {
  addItemLine, addMergeRecord, addModifierLine, addSplitCheckRecord, addTransferCheckRecord, hasLiveItems,
  applyMovePlan, markRoundSent, mergeInto, moveLines, newCheck, refIsShown, stampNoSec, type Check,
} from "@/model/check";
import { buildFinancialCheck, type SendContext } from "@/protocol/order";

const item = (id: string, price = 10) => ({ id, name: `item ${id}`, price: String(price) } as any);
const ctx: SendContext = {
  isisVer: "1", storeId: "3", securityToken: "T", terminalPosId: "20",
  employeePosId: "1", businessDateId: "9", checkNo: "200001",
};
const at = new Date(2026, 8, 16, 10, 5); // 2026-09-16 10:05

/** A sent source check: Coke (guest 1) + a modifier, Burger (guest 2). */
function sentSource(): Check {
  let c = newCheck("1", "", 2);
  c.checkNumber = "210003";
  c = addItemLine(c, item("55744", 1.5), "coke", 1);
  c = addModifierLine(c, "coke", item("999", 0), 0);
  c = addItemLine(c, item("777", 12), "burger", 2);
  return markRoundSent(c); // tray 1: coke=1, mod=2, burger=3
}

describe("stampNoSec", () => {
  it("is yyyy-MM-dd HH:mm (noSecDateFormatter)", () => expect(stampNoSec(at)).toBe("2026-09-16 10:05"));
});

describe("markRoundSent stamps server identity", () => {
  it("numbers unsent lines 1..n in order under the next tray", () => {
    const c = sentSource();
    expect(c.lines.map((l) => [l.trayNumber, l.lineNumber])).toEqual([[1, 1], [1, 2], [1, 3]]);
    expect(c.traysSent).toBe(1);
  });
});

describe("moveLines", () => {
  it("dest gets positive copies + one lixfer record per copy; modifiers ride along", () => {
    const src = sentSource();
    const dest = newCheck("1"); dest.checkNumber = "200042";
    const r = moveLines(src, dest, new Set(["coke"]), { kind: "lixfer", srcCheckNo: "210003", authEmpId: "9999", now: at });
    const d = r.dest.lines;
    // coke, rec, mod, rec
    expect(d.map((l) => l.kind)).toEqual(["M", "R", "Mo", "R"]);
    expect(d[0].amount).toBe(1.5); expect(d[0].sent).toBe(false); expect(d[0].transferOut).toBe(false);
    expect(d[0].authEmpId).toBe("9999");
    expect(d[2].parentKey).toBe(d[0].key); // parent link remapped to the new key
    const rec = JSON.parse(d[1].reference!);
    expect(rec).toEqual({ type: "lixfer", tray: 1, li: 1, mi: "item 55744", qt: 1, time: "2026-09-16 10:05", src: 210003 });
    expect(JSON.parse(d[3].reference!).li).toBe(3); // the modifier's line number (record consumed 2)
    expect(refIsShown(d[1])).toBe(false); // machine record, never rendered
  });

  it("source: sent originals become NEGATIVE Transfered_Out void-offs pointing at the original", () => {
    const src = sentSource();
    const r = moveLines(src, newCheck("1"), new Set(["coke"]), { kind: "lixfer", srcCheckNo: "210003", authEmpId: "9999" });
    const s = r.source.lines;
    expect(s.find((l) => l.key === "coke")).toBeUndefined();        // original gone
    const offs = s.filter((l) => l.transferOut);
    expect(offs).toHaveLength(2);                                     // coke + its modifier
    expect(offs[0].amount).toBe(-1.5); expect(offs[0].isVoid).toBe(false); expect(offs[0].sent).toBe(false);
    expect([offs[0].parentTrayNumber, offs[0].parentLineNumber]).toEqual([1, 1]);
    expect([offs[1].parentTrayNumber, offs[1].parentLineNumber]).toEqual([1, 2]);
    expect(s.find((l) => l.key === "burger")).toBeTruthy();           // untouched
  });

  it("an UNSENT original is simply dropped (server never saw it)", () => {
    let src = sentSource();
    src = addItemLine(src, item("100"), "fresh", 1);
    const r = moveLines(src, newCheck("1"), new Set(["fresh"]), { kind: "lixfer", srcCheckNo: "210003" });
    expect(r.source.lines.some((l) => l.key === "fresh" || (l.transferOut && l.menuItemId === "100"))).toBe(false);
    expect(r.dest.lines.filter((l) => l.kind === "M")).toHaveLength(1);
  });

  it("remaps guests via map + offset; whole-table (0) and reserved (>90) ride as-is", () => {
    let src = newCheck("1");
    src = addItemLine(src, item("a"), "a", 3);
    src = addItemLine(src, item("b"), "b", 0);
    src = addItemLine(src, item("c"), "c", 100);
    const map = new Map([[3, 1]]);
    const r = moveLines(src, newCheck("1"), new Set(["a", "b", "c"]), { kind: "chksplit", srcCheckNo: "1", guestMap: map, guestOffset: 2 });
    const g = r.dest.lines.filter((l) => l.kind === "M").map((l) => l.guestNumber);
    expect(g).toEqual([3, 0, 100]); // 3→1 (+2) = 3 ; 0 kept ; 100 kept
  });

  it("landing on a check with existing unsent lines continues the line numbering", () => {
    const src = sentSource();
    let dest = newCheck("1"); dest = addItemLine(dest, item("z"), "z", 1); // 1 unsent already
    const r = moveLines(src, dest, new Set(["burger"]), { kind: "lixfer", srcCheckNo: "210003" });
    expect(JSON.parse(r.dest.lines.at(-1)!.reference!).li).toBe(2);
  });
});

describe("hasLiveItems / records", () => {
  it("source emptied by a move has no live items → caller closes it", () => {
    const src = sentSource();
    const r = moveLines(src, newCheck("1"), new Set(["coke", "burger"]), { kind: "chksplit", srcCheckNo: "210003" });
    expect(hasLiveItems(r.source)).toBe(false);
    expect(hasLiveItems(r.dest)).toBe(true);
  });
  it("addSplitCheckRecord writes the check-level chksplit marker (hidden)", () => {
    const c = addSplitCheckRecord(newCheck("1"), "210003", "", at);
    expect(JSON.parse(c.lines[0].reference!)).toEqual({ type: "chksplit", time: "2026-09-16 10:05", src: 210003 });
    expect(refIsShown(c.lines[0])).toBe(false);
  });
  it("addTransferCheckRecord writes a SHOWN Xfer note + hidden chkxfer record", () => {
    const c = addTransferCheckRecord(newCheck("1"), { id: "1", name: "Furio Corso" }, { id: "5", name: "Kathy K" }, "9999", at);
    expect(c.lines[0].reference).toBe("Xfer from Furio Corso  to  Kathy K");
    expect(refIsShown(c.lines[0])).toBe(true);
    expect(JSON.parse(c.lines[1].reference!)).toEqual({ type: "chkxfer", fromempid: 1, toempid: 5, time: "2026-09-16 10:05" });
    expect(refIsShown(c.lines[1])).toBe(false);
  });
  it("addMergeRecord writes the shown CheckMerge:from:to:auth note", () => {
    expect(addMergeRecord(newCheck("1"), "210003", "200042", "Manager,Paul").lines[0].reference).toBe("CheckMerge:210003:200042:Manager,Paul");
    expect(addMergeRecord(newCheck("1"), "1", "2").lines[0].reference).toBe("CheckMerge:1:2: ");
  });
});

describe("wire", () => {
  it("a Transfered_Out void-off is hidden, Is_Void=0, negative, and points at the original line", () => {
    const r = moveLines(sentSource(), newCheck("1"), new Set(["burger"]), { kind: "lixfer", srcCheckNo: "210003", authEmpId: "9999" });
    const xml = buildFinancialCheck(r.source, ctx);
    const li = xml.match(/<LineItem [^>]*Transfered_Out="1"[^>]*>.*?<\/LineItem>/)![0];
    expect(li).toContain('Is_Void="0"');
    expect(li).toContain('Print_On_Check="0" Show_On_Display="0"');
    expect(li).toContain("<Parent_LineItem_ID>3</Parent_LineItem_ID><Parent_Tray_Number>1</Parent_Tray_Number>");
    expect(li).toContain("<AuthorizingEmployee_ID>9999</AuthorizingEmployee_ID>");
    expect(li).toContain("<Line_Amount>-12.00</Line_Amount>");
  });
  it("close → Is_Closed=1 without Is_Settled; transferred → Is_Transferred=1", () => {
    const c = newCheck("1");
    expect(buildFinancialCheck(c, ctx, { close: true })).toMatch(/Is_Closed="1"[^>]*Is_Settled="0"/);
    expect(buildFinancialCheck(c, ctx, { transferred: true })).toContain('Is_Transferred="1"');
    expect(buildFinancialCheck(c, ctx)).toContain('Is_Transferred="0"');
  });
  it("checkEmployeePosId overrides the check's owner but not the tray's sender", () => {
    const xml = buildFinancialCheck(newCheck("1"), { ...ctx, checkEmployeePosId: "5" });
    expect(xml).toContain("<Employee_POS_ID>5</Employee_POS_ID>");
    expect(xml).toContain('Employee_POS_ID="1" traykey=');
  });
});

describe("Transfer Check wire", () => {
  it("the check's own employeePosId is the header owner; the sender stays on the tray", () => {
    const c = { ...newCheck("1"), employeePosId: "5" };
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain("<Employee_POS_ID>5</Employee_POS_ID>");
    expect(xml).toContain('Employee_POS_ID="1" traykey=');
  });
});

describe("applyMovePlan (Split Check plan → core)", () => {
  const mk = (name: string): Check => ({ ...newCheck("1", name, 1), checkNumber: "200099" });
  it("compacts guests per new check, marks Split Guest new checks with chksplit, closes an emptied source", () => {
    let src = newCheck("1", "", 3); src.checkNumber = "210003";
    src = addItemLine(src, item("a"), "a", 3); src = addItemLine(src, item("b"), "b", 1); src = markRoundSent(src);
    const run = applyMovePlan(src, [{ kind: "new", name: "Tom", keys: new Set(["a", "b"]) }], { moveKind: "chksplit", srcCheckNo: "210003", authEmpId: "1", newCheck: mk, now: at });
    expect(run.closeSource).toBe(true);
    const d = run.dests[0].dest;
    expect(d.lines.filter((l) => l.kind === "M").map((l) => l.guestNumber)).toEqual([2, 1]); // guests {1,3} → {1,2}
    expect(d.guestCount).toBe(2);
    expect(d.lines.some((l) => l.kind === "R" && /"type":"chksplit","time"/.test(l.reference!))).toBe(true); // check-level marker
    expect(run.source.lines.filter((l) => l.transferOut)).toHaveLength(2);
  });
  it("lands after an existing check's guests (AfterGuest offset) and keeps the source open when items remain", () => {
    let src = newCheck("1", "", 2); src.checkNumber = "210003";
    src = addItemLine(src, item("a"), "a", 2); src = addItemLine(src, item("b"), "b", 1); src = markRoundSent(src);
    let ex = newCheck("1", "", 2); ex.checkNumber = "200042"; ex = addItemLine(ex, item("z"), "z", 1); ex = markRoundSent(ex);
    const run = applyMovePlan(src, [{ kind: "existing", name: "", dest: ex, keys: new Set(["a"]) }], { moveKind: "lixfer", srcCheckNo: "210003", newCheck: mk });
    expect(run.closeSource).toBe(false);
    const moved = run.dests[0].dest.lines.filter((l) => l.kind === "M" && !l.sent);
    expect(moved[0].guestNumber).toBe(3);                 // guest 2 → compact 1 → +2 existing guests
    expect(run.dests[0].dest.guestCount).toBe(3);
    expect(run.dests[0].dest.lines.some((l) => l.kind === "R" && /"type":"lixfer"/.test(l.reference!))).toBe(true);
    expect(run.dests[0].dest.lines.some((l) => l.kind === "R" && /"type":"chksplit"/.test(l.reference!))).toBe(false);
  });
  it("skips empty targets", () => {
    const src = markRoundSent(addItemLine(newCheck("1"), item("a"), "a", 1));
    const run = applyMovePlan(src, [{ kind: "new", name: "", keys: new Set() }], { moveKind: "chksplit", srcCheckNo: "1", newCheck: mk });
    expect(run.dests).toHaveLength(0); expect(run.closeSource).toBe(false);
  });
});

describe("mergeInto (Merge With Another Check)", () => {
  it("copies the source's live lines + tenders onto the destination after its guests; source gets the CheckMerge note", () => {
    let dest = newCheck("1", "", 2); dest.checkNumber = "200042";
    dest = addItemLine(dest, item("z"), "z", 1); dest = markRoundSent(dest);
    let src = newCheck("1", "", 1); src.checkNumber = "210003";
    src = addItemLine(src, item("a", 4), "a", 1); src = addModifierLine(src, "a", item("m", 0), 0);
    src = addItemLine(src, item("v"), "v", 1); src = markRoundSent(src);
    src = { ...src, lines: src.lines.map((l) => (l.key === "v" ? { ...l, isVoid: true } : l)) };
    src = { ...src, tenders: [{ key: "t1", tenderId: "9", name: "Cash", amount: 2, tip: 0, change: 0, sent: true }] };
    const { dest: d, source: s } = mergeInto(dest, src, "Manager,Paul");
    const moved = d.lines.filter((l) => !l.sent);
    expect(moved.map((l) => l.description)).toEqual(["item a", "item m"]);    // void line skipped
    expect(moved[0].guestNumber).toBe(3);                                      // after the dest's 2 guests
    expect(moved[1].parentKey).toBe(moved[0].key);                             // modifier re-parented
    expect(d.tenders.filter((t) => !t.sent)).toHaveLength(1);
    expect(d.guestCount).toBe(3);
    expect(s.lines.at(-1)!.reference).toBe("CheckMerge:210003:200042:Manager,Paul");
    expect(refIsShown(s.lines.at(-1)!)).toBe(true);
  });
});
