// @vitest-environment jsdom
/*
 * Check panel: a payment is a row after the items, and any line or payment is
 * selected by tapping it at any time, as on the iPad (rendered for real, tapped
 * through the DOM).
 */

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckPanel, { type CheckPanelProps } from "@/views/CheckPanel";
import type { Check } from "@/model/check";
import type { TaxResult } from "@/model/tax";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const check: Check = {
  id: "1234567", revenueCenterId: "1", tableName: "test", guestCount: 1, openedAt: 0, traysSent: 2, checkNumber: "280032",
  lines: [{ key: "a", menuItemId: "100", description: "Coffee", quantity: 1, amount: 10, kind: "M", indentLevel: 0, sent: true, trayNumber: 1, lineNumber: 1 }],
  tenders: [{ key: "t1", tenderId: "1", name: "Cash", amount: 4, tip: 0, change: 0, sent: true, trayNumber: 2, lineNumber: 1 }],
};
const tax = { taxTotal: 1, inclusiveTotal: 0, groups: [] } as unknown as TaxResult;

let host: HTMLDivElement, root: Root;
const noop = () => {};
const render = (over: Partial<CheckPanelProps>) => act(() => {
  root.render(createElement(CheckPanel, {
    check, tax, revenueCenterName: "Bar", onQty: noop, onRemove: noop, onSetTable: noop, onSetGuests: noop, onSend: noop, onPay: noop,
    onSplit: noop, onVoid: noop, onNewCheck: noop, ...over,
  } as CheckPanelProps));
});
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("check panel rows", () => {
  it("shows the payment after the items, with paid and balance in the header", () => {
    render({});
    const row = host.querySelector(".cl.tender") as HTMLElement;
    expect(row).not.toBeNull(); expect(row.textContent).toContain("Cash"); expect(row.textContent).toContain("$4.00");
    expect(host.querySelector(".cbreak")!.textContent).toMatch(/Paid \$4\.00 · Balance \$7\.00/);
  });
  it("a tap selects a payment or an item at any time, with no Edit mode (as on the iPad)", () => {
    const onToggleLine = vi.fn();
    render({ selectedKeys: new Set<string>(), onToggleLine });   // Edit Check screen NOT up
    const pay = host.querySelector(".cl.tender") as HTMLElement;
    const item = [...host.querySelectorAll(".cl")].find((e) => e.textContent!.includes("Coffee")) as HTMLElement;
    expect(pay.className).toContain("selectable"); expect(item.className).toContain("selectable");
    act(() => { pay.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    act(() => { item.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggleLine.mock.calls.map((c) => c[0])).toEqual(["t1", "a"]);
  });
  it("selected rows are highlighted and counted on the Edit check button", () => {
    render({ selectedKeys: new Set(["t1", "a", "gone"]) });   // a key no longer on the check is not counted
    expect((host.querySelector(".cl.tender") as HTMLElement).className).toContain("picked");
    const edit = [...host.querySelectorAll("button")].find((b) => b.textContent!.startsWith("Edit check"))!;
    expect(edit.textContent).toBe("Edit check · 2 selected");
  });
  it("the selection survives calling up the Edit Check screen, which shows the count and Done", () => {
    render({ editing: true, selectedKeys: new Set(["t1"]) });
    expect((host.querySelector(".cl.tender") as HTMLElement).className).toContain("picked");
    expect(host.querySelector(".cselcount")!.textContent).toBe("1 selected");
  });
  it("a voided payment cannot be selected; the quantity buttons on an unsent item do not select it", () => {
    const onToggleLine = vi.fn(), onQty = vi.fn();
    const c: Check = { ...check, tenders: [{ ...check.tenders[0], isVoid: true }], lines: [{ ...check.lines[0], sent: false, trayNumber: undefined, lineNumber: undefined }] };
    render({ check: c, onToggleLine, onQty, selectedKeys: new Set<string>() });
    const pay = host.querySelector(".cl.tender") as HTMLElement;
    expect(pay.className).not.toContain("selectable");
    act(() => { pay.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const plus = [...host.querySelectorAll(".clctl button")].find((b) => b.textContent === "+") as HTMLElement;
    act(() => { plus.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onQty).toHaveBeenCalledWith("a", 2); expect(onToggleLine).not.toHaveBeenCalled();
  });
});
