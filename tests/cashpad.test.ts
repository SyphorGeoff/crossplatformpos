// @vitest-environment jsdom
/*
 * Cash pad: opens on the balance with Apply ready (one press pays the exact
 * amount); the first key typed replaces it; backspace edits it.
 */

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CashPad } from "@/views/PaymentView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const mount = (due: number, onApply = vi.fn()) => { act(() => { root.render(createElement(CashPad, { due, rounding: "0.05", onApply, onBack: () => {} })); }); return onApply; };
const btn = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
const apply = () => [...host.querySelectorAll("button")].find((b) => b.textContent!.startsWith("Apply")) as HTMLButtonElement;
const press = (b: HTMLElement) => act(() => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const shown = () => (host.querySelector(".cashin") as HTMLInputElement).value;

describe("CashPad", () => {
  it("opens on the balance and Apply pays it in one press", () => {
    const onApply = mount(3.3);
    expect(shown()).toBe("3.30"); expect(apply().disabled).toBe(false); expect(apply().textContent).toBe("Apply $3.30");
    press(apply());
    expect(onApply).toHaveBeenCalledWith(3.3);
  });
  it("the first key replaces the balance, later keys append", () => {
    const onApply = mount(3.3);
    press(btn("2")); expect(shown()).toBe("2");
    press(btn("0")); expect(shown()).toBe("20");
    press(apply()); expect(onApply).toHaveBeenCalledWith(20);
  });
  it("a leading point starts 0. ; backspace edits the balance instead of clearing it", () => {
    mount(3.3);
    press(btn(".")); expect(shown()).toBe("0.");
    act(() => root.unmount()); root = createRoot(host);
    mount(3.3);
    press(btn("⌫")); expect(shown()).toBe("3.3");
    press(btn("5")); expect(shown()).toBe("3.35");
  });
  it("with nothing due the pad is empty and Apply waits for an amount", () => {
    mount(0);
    expect(shown()).toBe(""); expect(apply().disabled).toBe(true);
  });
});
