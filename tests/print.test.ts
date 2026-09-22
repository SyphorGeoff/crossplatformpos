import { describe, it, expect } from "vitest";
import { center, twoCol, itemLine, rule, PrintDoc, INIT, CUT, ESC } from "@/platform/escpos";
import { buildPrepChit, buildCustomerCheck, buildClockChit } from "@/protocol/printjobs";
import { buildKdsOrderJson } from "@/protocol/kdsorder";

describe("escpos formatting", () => {
  it("centers within width", () => {
    expect(center("AB", 6)).toBe("  AB");           // 2 leading spaces
    expect(center("TOOLONGTEXT", 4)).toBe("TOOL");  // truncates
  });
  it("right-justifies the value in twoCol", () => {
    expect(twoCol("Total", "$5.00", 20)).toBe("Total          $5.00");
    expect(twoCol("Total", "$5.00", 20)).toHaveLength(20);
  });
  it("lays out qty / name / amount and wraps long names", () => {
    const line = itemLine("2", "Coca Cola", "$3.00", 40);
    expect(line.startsWith("2  ")).toBe(true);
    expect(line).toContain("Coca Cola");
    expect(line.trimEnd().endsWith("$3.00")).toBe(true);
    const wrapped = itemLine("1", "Extra Long Sandwich Name That Wraps Around", "$9.00", 20);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);
  });
  it("rule fills the width", () => { expect(rule(5)).toBe("-----"); });
  it("PrintDoc frames with init and cut", () => {
    const doc = new PrintDoc(32).line("hi").cut().toString();
    expect(doc.startsWith(INIT)).toBe(true);
    expect(doc).toContain(CUT);
    expect(doc).toContain("hi");
  });
});

describe("prep chit", () => {
  const ctx = { checkNo: "200001", server: "Furio Corso", guests: 2, rcName: "Bar", tabLabel: "TBL: 8", date: "2026-08-28", time: "12:00" };
  it("lists items with qty and modifiers, no prices, CHECKNUM header", () => {
    const job = buildPrepChit("Bar Printer", ctx, [{ qty: 2, name: "Latte", mods: ["Oat milk"] }], 32);
    expect(job).toContain("Latte");
    expect(job).toContain("- Oat milk");
    expect(job).toContain("CHECKNUM: 200001");
    expect(job).toContain("Furio C");    // first name + last initial
    expect(job).not.toContain("$");
    expect(job).toContain(CUT);
  });
  it("withholds held items from the kitchen", () => {
    const job = buildPrepChit("P", ctx, [{ qty: 1, name: "Fries", mods: [], held: true }, { qty: 1, name: "Burger", mods: [] }], 40);
    expect(job).not.toContain("Fries");
    expect(job).toContain("Burger");
  });
});

describe("customer check", () => {
  it("prints header, items, tax, total, trailer", () => {
    const job = buildCustomerCheck(
      { headerLines: ["AIREUS CAFE", "|", ""], trailerLines: ["18%: ${SUBT*18%}", "Thank you!"], checkNo: "200001", server: "Furio", guests: 1, date: "today",
        tokens: { firstName: "Furio", lastName: "Corso", tabName: "", subtotal: 38, grandTotal: 41.8 } },
      [{ qty: 1, name: "Coffee", amount: 3, indent: 0, isMod: false }],
      3, [{ name: "Sales Tax", amount: 0.3 }], 3.3, [], 3.3, 40,
    );
    expect(job).toContain("AIREUS CAFE");
    expect(job).toContain("Coffee");
    expect(job).toContain("Sales Tax");
    expect(job).toContain("$3.30");
    expect(job).toContain("Thank you!");
    expect(job).toContain("CHK: 200001");
  });
  it("resolves gratuity tokens and honors |=blank / empty=skip", () => {
    const job = buildCustomerCheck(
      { headerLines: ["STORE", "", "|"], trailerLines: ["18%: ${SUBT*18%}"], checkNo: "1", server: "S", guests: 1, date: "d",
        tokens: { firstName: "A", lastName: "B", tabName: "", subtotal: 38, grandTotal: 41.8 } },
      [{ qty: 1, name: "X", amount: 1, indent: 0, isMod: false }], 38, [], 41.8, [], 41.8, 40,
    );
    expect(job).toContain("18%: $6.84 Total: $48.64"); // 38*.18=6.84 ; 41.80+6.84=48.64
    expect(job).not.toContain("${SUBT");
    expect(job).not.toMatch(/\n\|/); // a lone "|" became a blank line, not a literal pipe
  });
});

describe("KDS order JSON (getKDSOrderString)", () => {
  it("builds valid JSON with header, lineitems, footer matching the iOS shape", () => {
    const json = buildKdsOrderJson("uuid-1", {
      token: "TOK", entid: "3", entcode: "ENOX", server: "Furio Corso", empId: "1", guests: 2, checkNo: "200001",
      date: "today", revenueCenter: "Bar", tableName: "Table 8", store: "3", printerId: "27", bdid: "90042",
      checkKey: "4554831", togo: "", vip: "", allergy: "0",
    }, [
      { lineitemkey: "4554831:3125451", quantity: "1", description: "Latte", amount: "12.00", guestNumber: "1", indentLevel: 0, reference: "", type: "M", isVoid: "0" },
      { lineitemkey: "4554831:3125452", quantity: "1", description: "Oat milk", amount: "0.00", guestNumber: "1", indentLevel: 1, reference: "", type: "Mo", isVoid: "0" },
    ], { tax: "1.20", total: "13.20" });
    const o = JSON.parse(json);
    expect(o.UUID).toBe("uuid-1");
    expect(o.check.Token).toBe("TOK");
    expect(o.check.entid).toBe("3");
    expect(o.check.header.checkNumber).toBe("Check: 200001");
    expect(o.check.header.server).toBe("Server: Furio Corso");
    expect(o.check.header.printer).toBe("27");
    expect(o.check.header.checkkey).toBe("4554831");
    expect(o.check.lineitem).toHaveLength(2);
    expect(o.check.lineitem[0].type).toBe("M");
    expect(o.check.lineitem[1].type).toBe("Mo");
    expect(o.check.lineitem[0].lineitemkey).toBe("4554831:3125451");
    expect(o.check.footer.total).toBe("13.20");
  });
});

describe("clock chit", () => {
  it("renders a clock-in chit with job and rate", () => {
    const job = buildClockChit({ storeName: "Aireus Cafe", empName: "Furio Corso", action: "IN", jobName: "Bartender", time: "12:00", rate: 12.3 }, 40);
    expect(job).toContain("CLOCK IN");
    expect(job).toContain("Furio Corso");
    expect(job).toContain("Bartender");
    expect(job).toContain("$12.30/hr");
    expect(job.startsWith(ESC + "@")).toBe(true);
  });
});
