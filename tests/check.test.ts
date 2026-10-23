/*
 * Split logic — splitToNewCheck moves selected item lines (with their modifiers)
 * onto a new check. Already-sent lines leave a negative Transfered_Out void-off
 * on the source; unsent lines are simply dropped.
 */

import { describe, expect, it } from "vitest";
import { splitToNewCheck, checkSubtotal, generateCheckKey, newCheck, sweepUnsentForIdle, type Check, type CheckLine } from "@/model/check";

describe("generateCheckKey (iOS numeric key)", () => {
  it("is a 7-digit numeric string", () => {
    for (let i = 0; i < 200; i++) expect(generateCheckKey()).toMatch(/^\d{7}$/);
  });
  it("is unique across many mints and used for check ids", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateCheckKey()));
    expect(keys.size).toBe(500);
    expect(newCheck("3").id).toMatch(/^\d{7}$/);
  });
});

let lineNo = 0;
const line = (o: Partial<CheckLine> & { key: string; menuItemId: string }): CheckLine =>
  ({ description: o.menuItemId, quantity: 1, amount: 10, kind: "M", indentLevel: 0, trayNumber: 1, lineNumber: ++lineNo, ...o });
const mk = (lines: CheckLine[]): Check =>
  ({ id: "SRC", revenueCenterId: "1", tableName: "5", diningTableId: "28", guestCount: 2, lines, tenders: [], traysSent: 1, openedAt: 0 });

describe("splitToNewCheck", () => {
  it("moves a sent item to a new check and leaves a void-off on the source", () => {
    const src = mk([
      line({ key: "a", menuItemId: "100", amount: 10, sent: true }),
      line({ key: "b", menuItemId: "200", amount: 6, sent: true }),
    ]);
    const { source, dest } = splitToNewCheck(src, new Set(["b"]));
    // dest: a fresh positive copy of b (plus its chksplit records), on the same table, unsent
    const items = dest.lines.filter((l) => l.kind === "M");
    expect(items).toHaveLength(1);
    expect(items[0].menuItemId).toBe("200");
    expect(items[0].amount).toBe(6);
    expect(items[0].sent).toBe(false);
    expect(dest.diningTableId).toBe("28");
    expect(dest.guestCount).toBe(1); // guests that MOVED, not the source's count
    // source: keeps a, plus a negative Transfered_Out void-off for b
    expect(source.lines.find((l) => l.key === "a")).toBeTruthy();
    const voidOff = source.lines.find((l) => l.transferOut);
    expect(voidOff).toBeTruthy();
    expect(voidOff!.amount).toBe(-6);
    expect(voidOff!.sent).toBe(false);
    expect(voidOff!.parentLineNumber).toBe(2); // Parent_* → the original (tray 1, line 2)
    // subtotal excludes the void-off → only a ($10) remains
    expect(checkSubtotal(source)).toBe(10);
  });

  it("drops an unsent item (no void-off) since the server never saw it", () => {
    const src = mk([
      line({ key: "a", menuItemId: "100", amount: 10, sent: true }),
      line({ key: "b", menuItemId: "200", amount: 6 }), // unsent
    ]);
    const { source, dest } = splitToNewCheck(src, new Set(["b"]));
    expect(dest.lines.filter((l) => l.kind === "M")).toHaveLength(1);
    expect(source.lines).toHaveLength(1); // only a; no void-off
    expect(source.lines[0].key).toBe("a");
    expect(source.lines.some((l) => l.transferOut)).toBe(false);
  });

  it("moves a modifier along with its parent item", () => {
    const src = mk([
      line({ key: "a", menuItemId: "100", amount: 10, sent: true }),
      line({ key: "am", menuItemId: "999", amount: 0, kind: "Mo", indentLevel: 1, parentKey: "a", sent: true }),
      line({ key: "b", menuItemId: "200", amount: 6, sent: true }),
    ]);
    const { dest } = splitToNewCheck(src, new Set(["a"]));
    expect(dest.lines.filter((l) => l.kind !== "R")).toHaveLength(2); // a + its modifier
    const parent = dest.lines.find((l) => l.menuItemId === "100")!;
    const mod = dest.lines.find((l) => l.menuItemId === "999")!;
    expect(mod.parentKey).toBe(parent.key); // parent link remapped to the new key
  });
});

describe("idle timeout sweep (iPad idleTimerExceeded)", () => {
  const base = (): Check => ({ id: "1", revenueCenterId: "1", tableName: "", guestCount: 1, lines: [], tenders: [], traysSent: 1, openedAt: 0 } as unknown as Check);
  const line = (key: string, kind: string, extra: Partial<CheckLine> = {}): CheckLine => ({ key, kind, menuItemId: "", description: key, quantity: 1, amount: 1, indentLevel: 0, ...extra } as CheckLine);
  it("drops unsent items with their modifiers and unsent adjustments, keeps sent lines", () => {
    const c = { ...base(), lines: [line("a", "M", { sent: true }), line("b", "M"), line("bm", "Mo", { parentKey: "b" }), line("adj", "A"), line("sadj", "A", { sent: true })] };
    const r = sweepUnsentForIdle(c, ["99"]);
    expect(r.check.lines.map((l) => l.key)).toEqual(["a", "sadj"]);
    expect(r.keepCheck).toBe(true);
  });
  it("keeps unsent gift-card lines and counts them as worth keeping", () => {
    const c = { ...base(), lines: [line("g", "M", { menuItemId: "99" }), line("b", "M")] };
    const r = sweepUnsentForIdle(c, ["99", ""]);
    expect(r.check.lines.map((l) => l.key)).toEqual(["g"]);
    expect(r.keepCheck).toBe(true);
  });
  it("an all-unsent check sweeps to nothing and is not kept", () => {
    const c = { ...base(), lines: [line("b", "M"), line("c", "M")] };
    const r = sweepUnsentForIdle(c, []);
    expect(r.check.lines).toEqual([]);
    expect(r.keepCheck).toBe(false);
  });
});
