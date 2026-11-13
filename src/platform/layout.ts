/*
 * Layout mode. "mini" is the small-screen layout (a phone, or the Stripe S710: a
 * 5.5" panel the WebView reports at roughly 360x640 CSS px): one column, the check
 * panel slides over the menu behind a button. "full" is the tablet layout.
 *
 * One rule everywhere (Geoff 2026-11-13): the screen width decides — 760px or
 * narrower is mini, wider is full — and the Manager Console can force mini on a
 * wide screen (for testing the small layout on a PC or tablet). On a wide screen a
 * forced mini is boxed into a 360x640 frame. Nothing can force the tablet layout
 * onto a small screen, and no build forces either: a landscape countertop reader
 * gets the tablet layout by its width just as a phone gets mini by its own.
 */

import { loadStr, saveStr } from "./storage";

export type LayoutSetting = "auto" | "mini";

const KEY = "layout.v1";
const MINI_QUERY = "(max-width: 760px)";   // narrow screen → mini
const FRAME_QUERY = "(min-width: 440px)";  // forced mini with room for the 380px frame → draw it

export function layoutSetting(): LayoutSetting { return loadStr(KEY, "auto") === "mini" ? "mini" : "auto"; }

let apply: (() => void) | null = null;

/** Store the console's choice and re-lay the page at once. */
export function setLayoutSetting(v: LayoutSetting): void { saveStr(KEY, v); apply?.(); }

/** What is in force now: "mini" or "full" (what the console row shows beside its setting). */
export function layoutInForce(): "mini" | "full" {
  return document.documentElement.dataset.layout === "mini" ? "mini" : "full";
}

export function installLayout(): void {
  const html = document.documentElement;
  const mini = window.matchMedia(MINI_QUERY);
  const room = window.matchMedia(FRAME_QUERY);
  apply = () => {
    const forced = layoutSetting() === "mini";
    html.dataset.layout = forced || mini.matches ? "mini" : "full";
    html.classList.toggle("miniframe", forced && room.matches);
  };
  apply();
  for (const mq of [mini, room]) {
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
    else mq.addListener(apply); // older WebViews
  }
}
