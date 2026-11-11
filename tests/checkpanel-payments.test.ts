// @vitest-environment jsdom
/*
 * Check panel: a payment is a row after the items, and in Edit mode it can be
 * picked like an item (rendered for real, tapped through the DOM).
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

describe("payment row on the check panel", () => {
  it("shows the payment after the items, with paid and balance in the header", () => {
    render({});
    const row = host.querySelector(".cl.tender") as HTMLElement;
    expect(row).not.toBeNull(); expect(row.textContent).toContain("Cash"); expect(row.textContent).toContain("$4.00");
    expect(host.querySelector(".cbreak")!.textContent).toMatch(/Paid \$4\.00 · Balance \$7\.00/);
    expect(row.querySelector(".clcheck")).toBeNull();   // not selectable outside Edit mode
  });
  it("Edit mode: tapping the payment row picks it, like an item", () => {
    const onToggleLine = vi.fn();
    render({ editing: true, selectedKeys: new Set<string>(), onToggleLine });
    const row = host.querySelector(".cl.tender") as HTMLElement;
    expect(row.className).toContain("selectable"); expect(row.querySelector(".clcheck")!.textContent).toBe("☐");
    act(() => { row.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggleLine).toHaveBeenCalledWith("t1");
    render({ editing: true, selectedKeys: new Set(["t1"]), onToggleLine });
    const picked = host.querySelector(".cl.tender") as HTMLElement;
    expect(picked.className).toContain("picked"); expect(picked.querySelector(".clcheck")!.textContent).toBe("☑");
  });
});
