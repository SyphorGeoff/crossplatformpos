/*
 * Split logic — splitToNewCheck moves selected item lines (with their modifiers)
 * onto a new check. Already-sent lines leave a negative Transfered_Out void-off
 * on the source; unsent lines are simply dropped.
 */

import { describe, expect, it } from "vitest";
import { splitToNewCheck, checkSubtotal, type Check, type CheckLine } from "@/model/check";

const line = (o: Partial<CheckLine> & { key: string; menuItemId: string }): CheckLine =>
  ({ description: o.menuItemId, quantity: 1, amount: 10, kind: "M", indentLevel: 0, ...o });
const mk = (lines: CheckLine[]): Check =>
  ({ id: "SRC", revenueCenterId: "1", tableName: "5", diningTableId: "28", guestCount: 2, lines, tenders: [], traysSent: 1, openedAt: 0 });

describe("splitToNewCheck", () => {
  it("moves a sent item to a new check and leaves a void-off on the source", () => {
    const src = mk([
      line({ key: "a", menuItemId: "100", amount: 10, sent: true }),
      line({ key: "b", menuItemId: "200", amount: 6, sent: true }),
    ]);
    const { source, dest } = splitToNewCheck(src, new Set(["b"]));
    // dest: a fresh positive copy of b, on the same table, unsent
    expect(dest.lines).toHaveLength(1);
    expect(dest.lines[0].menuItemId).toBe("200");
    expect(dest.lines[0].amount).toBe(6);
    expect(dest.lines[0].sent).toBe(false);
    expect(dest.diningTableId).toBe("28");
    // source: keeps a, plus a negative Transfered_Out void-off for b
    expect(source.lines.find((l) => l.key === "a")).toBeTruthy();
    const voidOff = source.lines.find((l) => l.transferOut);
    expect(voidOff).toBeTruthy();
    expect(voidOff!.amount).toBe(-6);
    expect(voidOff!.sent).toBe(false);
    // subtotal excludes the void-off → only a ($10) remains
    expect(checkSubtotal(source)).toBe(10);
  });

  it("drops an unsent item (no void-off) since the server never saw it", () => {
    const src = mk([
      line({ key: "a", menuItemId: "100", amount: 10, sent: true }),
      line({ key: "b", menuItemId: "200", amount: 6 }), // unsent
    ]);
    const { source, dest } = splitToNewCheck(src, new Set(["b"]));
    expect(dest.lines).toHaveLength(1);
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
    expect(dest.lines).toHaveLength(2); // a + its modifier
    const parent = dest.lines.find((l) => l.menuItemId === "100")!;
    const mod = dest.lines.find((l) => l.menuItemId === "999")!;
    expect(mod.parentKey).toBe(parent.key); // parent link remapped to the new key
  });
});
