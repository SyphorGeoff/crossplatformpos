/*
 * Card slip — layout of the two tickets (iPad PrintManager getReceiptHeader /
 * printReceipt) and the rule that decides whether a slip prints
 * (CheckViewController.m 7517-7541).
 */

import { describe, expect, it } from "vitest";
import { buildCardSlip, buildCardSlips, shouldPrintCardSlip, slipServerName, type CardSlipCtx } from "@/protocol/cardslip";

/** The printed text of a job: control sequences removed, one entry per line. */
const text = (job: string): string[] =>
  job.replace(/\x1b@/g, "").replace(/\x1b[a!r][\s\S]/g, "").replace(/\x1dV[\s\S]/g, "").split("\n").map((l) => l.trimEnd());

const base: CardSlipCtx = {
  store: { identification: "AIREUS and CO.", address1: "201 Whitehall Drive", address2: "", city: "Orlando FL USA" },
  server: "Furio Corso", time: "1:08 PM", date: "11/11/2026", checkNo: "280005", tabName: "padtest",
  kind: "auth", cardType: "VISA", last4: "4242", amount: 6.32, tip: 0, authCode: "123456",
  cardLines: ["Account: credit", "APN: VISA CREDIT", "AID: A0000000031010", "TVR: 0000008000", "TSI: E800", "Cryptogram: ABCDEF0123456789", "ENTRY: contact emv"],
};

describe("hold (PREAUTH) slip", () => {
  const m = text(buildCardSlip(base, "merchant", 40));
  it("header: store lines, rule, Transaction Record, server + time + date, check and tab", () => {
    expect(m.slice(0, 3)).toEqual(["AIREUS and CO.", "201 Whitehall Drive", "Orlando FL USA"]);   // the empty Address_2 prints nothing
    expect(m[3]).toBe(""); expect(m[4]).toBe("_".repeat(40)); expect(m[5]).toBe("Transaction Record");
    expect(m[6].startsWith("Server Name: Furio C 1:08 PM")).toBe(true); expect(m[6].endsWith("11/11/2026")).toBe(true); expect(m[6]).toHaveLength(40);
    expect(m[7]).toBe("Check #:280005  padtest");
  });
  it("type, PURCHASE, card and amount, then the card lines", () => {
    expect(m.slice(8, 14)).toEqual(["CreditPreAuth", "", "PURCHASE", "", "VISA", "Card#:4242"]);
    const amt = m.findIndex((l) => l.startsWith("Amount:"));
    expect(m[amt].endsWith("$6.32")).toBe(true);
    expect(m.slice(amt + 1, amt + 8)).toEqual(base.cardLines);
  });
  it("blank Tip and Total lines for the guest to fill in, then the auth code and the copy name", () => {
    const tip = m.indexOf("Tip   :_____________________");
    expect(tip).toBeGreaterThan(0); expect(m[tip + 2]).toBe("Total :_____________________");
    expect(m).toContain("Auth#: 123456"); expect(m).toContain("----- Merchant Copy --------");
    expect(m.indexOf("Auth#: 123456")).toBeGreaterThan(tip);
  });
  it("carries no signature line, agreement text or cardholder name", () => {
    const all = m.join("\n");
    expect(all).not.toMatch(/signature|agree|cardholder|x-{5,}/i);
  });
  it("ends with a cut", () => { expect(buildCardSlip(base, "merchant").endsWith("\x1dV\x30")).toBe(true); });
});

describe("sale (CREDIT) slip", () => {
  const s = text(buildCardSlip({ ...base, kind: "sale", cardType: "INTERAC", last4: "1933", amount: 6.32, tip: 1.25 }, "merchant", 40));
  it("prints the tip and the total as amounts, with no blank lines to fill in", () => {
    expect(s).toContain("CreditSale");
    const amt = s.findIndex((l) => l.startsWith("Amount:"));
    expect(s[amt + 1].startsWith("Tip   :")).toBe(true); expect(s[amt + 1].endsWith("$1.25")).toBe(true);
    expect(s[amt + 2].startsWith("Total :")).toBe(true); expect(s[amt + 2].endsWith("$7.57")).toBe(true);
    expect(s.join("\n")).not.toMatch(/(Tip|Total) *:_+/);
    expect(s).toContain("INTERAC"); expect(s).toContain("Card#:1933"); expect(s).toContain("Account: credit");
  });
});

describe("guest copy", () => {
  it("is the same record, named Guest Copy", () => {
    const g = text(buildCardSlip(base, "guest", 40));
    expect(g).toContain("----- Guest Copy -------"); expect(g).not.toContain("----- Merchant Copy --------");
    expect(g).toContain("Auth#: 123456"); expect(g).toContain("Tip   :_____________________");
  });
  it("carries the check trailer when the revenue center asks for it; a hold resolves tip tokens on the payment", () => {
    const g = text(buildCardSlip({ ...base, amount: 20, trailerLines: ["Suggested Gratuities:", "|", "18%: {SUBT*18%}", "", "Thank you {CHK_FIRST_NAME}"], tokens: { firstName: "Furio", lastName: "Corso", tabName: "padtest" } }, "guest", 40));
    const i = g.indexOf("Suggested Gratuities:");
    expect(i).toBeGreaterThan(g.indexOf("Auth#: 123456"));
    expect(g[i - 2]).toBe("-".repeat(40));
    expect(g.slice(i, i + 4)).toEqual(["Suggested Gratuities:", "", "18%: 3.60 Total: $23.60", "Thank you Furio"]);
    expect(g.indexOf("----- Guest Copy -------")).toBeGreaterThan(i);
  });
  it("a sale prints '-' for tip tokens; the merchant copy never carries the trailer", () => {
    const ctx: CardSlipCtx = { ...base, kind: "sale", trailerLines: ["18%: {SUBT*18%}"] };
    expect(text(buildCardSlip(ctx, "guest"))).toContain("18%: -");
    expect(text(buildCardSlip(ctx, "merchant")).join("\n")).not.toContain("18%");
  });
});

describe("buildCardSlips", () => {
  it("returns the Merchant Copy first, then the Guest Copy", () => {
    const [a, b] = buildCardSlips(base, 40);
    expect(a).toContain("Merchant Copy"); expect(b).toContain("Guest Copy");
  });
});

describe("slipServerName", () => {
  it("first name and the last initial", () => {
    expect(slipServerName("Furio Corso")).toBe("Furio C"); expect(slipServerName("Mary Jo Smith")).toBe("Mary S"); expect(slipServerName("Admin")).toBe("Admin"); expect(slipServerName("")).toBe("");
  });
});

describe("shouldPrintCardSlip", () => {
  it("a hold prints at or above the tender threshold, always when there is none", () => {
    expect(shouldPrintCardSlip("auth", 5, 0, false)).toBe(true);
    expect(shouldPrintCardSlip("auth", 5, 0, true)).toBe(true);
    expect(shouldPrintCardSlip("auth", 24.99, 25, false)).toBe(false);
    expect(shouldPrintCardSlip("auth", 25, 25, false)).toBe(true);
  });
  it("a sale with a threshold prints at or above it; with none it follows the store's print-on-demand setting", () => {
    expect(shouldPrintCardSlip("sale", 25, 25, true)).toBe(true);
    expect(shouldPrintCardSlip("sale", 24.99, 25, false)).toBe(false);
    expect(shouldPrintCardSlip("sale", 5, 0, false)).toBe(true);
    expect(shouldPrintCardSlip("sale", 5, 0, true)).toBe(false);
  });
});
