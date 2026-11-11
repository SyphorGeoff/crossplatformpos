/*
 * Number pad entry state — the card amount pad opens on the balance; the first
 * digit replaces it, backspace edits it, and an ordinary pad is unchanged.
 */

import { describe, expect, it } from "vitest";
import { padKey, padStart, type PadState } from "@/model/numpad";

const type = (s: PadState, keys: string) => [...keys].reduce((acc, k) => padKey(acc, k === "<" ? "⌫" : k), s);

describe("prefilled pad", () => {
  it("opens on the balance: OK with no typing accepts it", () => {
    expect(padStart("632", true)).toEqual({ digits: "632", fresh: true });
  });
  it("the first digit replaces the balance, later digits append", () => {
    expect(type(padStart("632", true), "5")).toEqual({ digits: "5", fresh: false });
    expect(type(padStart("632", true), "500").digits).toBe("500");
  });
  it("backspace edits the balance instead of clearing it; digits then append", () => {
    expect(type(padStart("632", true), "<")).toEqual({ digits: "63", fresh: false });
    expect(type(padStart("632", true), "<0").digits).toBe("630");
  });
  it("a zero balance is an empty pad, and a leading zero never sticks", () => {
    expect(padStart("0", true)).toEqual({ digits: "", fresh: false });
    expect(type(padStart("632", true), "0").digits).toBe("");
    expect(type(padStart("632", true), "05").digits).toBe("5");
  });
  it("ignores anything that is not a digit and caps at nine digits", () => {
    expect(type(padStart("632", true), "x")).toEqual({ digits: "632", fresh: true });
    expect(type(padStart("", true), "12345678901").digits).toBe("123456789");
  });
});

describe("ordinary pad", () => {
  it("without prefill the starting value is edited, not replaced", () => {
    const s = padStart("450", false);
    expect(s.fresh).toBe(false); expect(type(s, "0").digits).toBe("4500");
  });
});
