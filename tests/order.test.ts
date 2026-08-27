/*
 * Send-to-kitchen wire format — the FinancialCheck document must match what the
 * iPad emits (FinancialCheckManager.m xmlCheckPost/xmlTray/lineItemtoString).
 * These lock the byte shape and the modifier parent-linkage.
 */

import { describe, expect, it } from "vitest";
import { buildFinancialCheck, escapeXml, nextCheckNo, type SendContext } from "@/protocol/order";
import type { Check } from "@/model/check";

const ctx: SendContext = {
  isisVer: "ver 1.0.0", storeId: "3", securityToken: "TOK", terminalPosId: "20",
  employeePosId: "5", businessDateId: "90042", checkNo: "200001",
};

const check: Check = {
  id: "CK1", revenueCenterId: "3", tableName: "Bob's & Table", guestCount: 2, openedAt: 0,
  traysSent: 0, tenders: [],
  lines: [
    { key: "a", menuItemId: "100", description: "T-Bone", quantity: 1, amount: 18, kind: "M", indentLevel: 0, guestNumber: 1 },
    { key: "b", menuItemId: "200", description: "Rare", quantity: 1, amount: 0, kind: "Mo", indentLevel: 1, parentKey: "a" },
    { key: "c", menuItemId: "300", description: "Already fired", quantity: 1, amount: 5, kind: "M", indentLevel: 0, sent: true },
  ],
};

describe("escapeXml", () => {
  it("escapes & then ' and newlines (iPad order)", () => {
    expect(escapeXml("a & b's\nc")).toBe("a &amp; b&apos;s&#xA;c");
  });
});

describe("nextCheckNo", () => {
  it("highest+1 when the store has checks today", () => expect(nextCheckNo(480006, "20")).toBe("480007"));
  it("{terminalId}0001 when the store has none yet", () => expect(nextCheckNo(0, "20")).toBe("200001"));
});

describe("buildFinancialCheck", () => {
  const xml = buildFinancialCheck(check, ctx);

  it("has the FinancialCheck DTD and root", () => {
    expect(xml).toContain('<!DOCTYPE FinancialCheck SYSTEM "Transactions/Post_Messages/FinancialCheck.dtd">');
    expect(xml).toContain('<FinancialCheck ');
  });
  it("carries the check-level attributes", () => {
    expect(xml).toContain('Guest_Count="2"');
    expect(xml).toContain('Is_New="1"');
    expect(xml).toContain('Check_Name="Bob&apos;s &amp; Table"'); // escaped
  });
  it("emits the header fields in order with the resolved values", () => {
    expect(xml).toContain("<ISIS_Ver>ver 1.0.0</ISIS_Ver><BusinessDate_ID>90042</BusinessDate_ID><Store_ID>3</Store_ID><Security_Token>TOK</Security_Token><Check_No>200001</Check_No><Employee_POS_ID>5</Employee_POS_ID>");
    expect(xml).toContain("<RevenueCenter_POS_ID>3</RevenueCenter_POS_ID>");
    expect(xml).toContain("<check_key>CK1</check_key>");
  });
  it("wraps lines in one Tray tagged with terminal + employee", () => {
    expect(xml).toMatch(/<Tray Tray_Number="1" Terminal_POS_ID="20" Sent_On="[^"]+" Employee_POS_ID="5" traykey="[^"]+">/);
  });
  it("emits the item line as Type=M with MenuItem_POS_ID, Line_Number and Line_Amount", () => {
    expect(xml).toContain('Type="M"');
    expect(xml).toContain("<Line_Number>1</Line_Number><MenuItem_POS_ID>100</MenuItem_POS_ID><Line_Amount>18.00</Line_Amount>");
  });
  it("Line_Amount is extended (unit × quantity)", () => {
    const c: Check = { ...check, lines: [{ key: "q", menuItemId: "9", description: "x", quantity: 3, amount: 5, kind: "M", indentLevel: 0 }] };
    expect(buildFinancialCheck(c, ctx)).toContain("<Quantity>3</Quantity><Line_Number>1</Line_Number><MenuItem_POS_ID>9</MenuItem_POS_ID><Line_Amount>15.00</Line_Amount>");
  });
  it("emits DiningTable_POS_ID only when the check is table-bound", () => {
    expect(xml).not.toContain("DiningTable_POS_ID");
    const c: Check = { ...check, diningTableId: "28" };
    expect(buildFinancialCheck(c, ctx)).toContain("<DiningTable_POS_ID>28</DiningTable_POS_ID>");
  });
  it("links the modifier to its parent's Line_Number and Tray", () => {
    // modifier b is line 2, parent a is line 1, tray 1
    expect(xml).toContain("<Parent_LineItem_ID>1</Parent_LineItem_ID><Parent_Tray_Number>1</Parent_Tray_Number>");
    expect(xml).toContain("<Line_Number>2</Line_Number><MenuItem_POS_ID>200</MenuItem_POS_ID>");
  });
  it("excludes already-sent lines (only the unsent round is fired)", () => {
    expect(xml).not.toContain("<MenuItem_POS_ID>300</MenuItem_POS_ID>");
  });
  it("emits a <Tax_Group_Amt> per report group when tax groups are given", () => {
    const withTax = buildFinancialCheck(check, ctx, { taxGroups: [{ reportGroupId: "2", amount: "1.80", isExempt: false }] });
    expect(withTax).toContain('<Tax_Group_Amt><Tax_Report_Group_POS_ID Is_Exempt="0">2</Tax_Report_Group_POS_ID><Tax_Amount>1.80</Tax_Amount></Tax_Group_Amt>');
  });
  it("is not settled by default (Is_Closed/Is_Settled = 0)", () => {
    expect(xml).toContain('Is_Closed="0"');
    expect(xml).toContain('Is_Settled="0"');
    expect(xml).toContain('is_Settled=""'); // lowercase always empty (iPad quirk)
  });
});

describe("buildFinancialCheck adjustments / voids / cancel", () => {
  it("emits an adjustment as Type=A with Adjustment_POS_ID + authorizing employee + negative amount", () => {
    const c: Check = { ...check, lines: [{ key: "d", menuItemId: "", description: "Comp", quantity: 1, amount: -5, kind: "A", indentLevel: 0, adjustmentId: "4", authEmpId: "1" }] };
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain('Type="A"');
    expect(xml).toContain("<AuthorizingEmployee_ID>1</AuthorizingEmployee_ID>");
    expect(xml).toContain("<Adjustment_POS_ID>4</Adjustment_POS_ID>");
    expect(xml).toContain("<Line_Amount>-5.00</Line_Amount>");
  });
  it("emits a void reversal with Is_Void, Void_POS_ID and the authorizer", () => {
    const c: Check = { ...check, lines: [{ key: "v", menuItemId: "100", description: "T-Bone", quantity: 1, amount: -18, kind: "M", indentLevel: 0, isVoid: true, voidPosId: "5", authEmpId: "1" }] };
    const xml = buildFinancialCheck(c, ctx);
    expect(xml).toContain('Is_Void="1"');
    expect(xml).toContain("<Void_POS_ID>5</Void_POS_ID>");
    expect(xml).toContain("<AuthorizingEmployee_ID>1</AuthorizingEmployee_ID>");
    expect(xml).toContain("<Line_Amount>-18.00</Line_Amount>");
  });
  it("cancel flips Is_Cancelled and Is_Closed to 1", () => {
    const xml = buildFinancialCheck(check, ctx, { cancel: true });
    expect(xml).toContain('Is_Cancelled="1"');
    expect(xml).toContain('Is_Closed="1"');
  });
});

describe("buildFinancialCheck settle", () => {
  const settled: Check = {
    ...check, traysSent: 1, // items already fired in tray 1
    lines: check.lines.map((l) => ({ ...l, sent: true })),
    tenders: [
      { key: "t1", tenderId: "1", name: "Cash", amount: 20, tip: 0, change: 3 },
      { key: "t2", tenderId: "18", name: "Gift Card", amount: 5, tip: 0, change: 0, reference: "1234", balanceRef: "12.00" },
    ],
  };
  const xml = buildFinancialCheck(settled, ctx, { settle: true });

  it("flips Is_Closed and Is_Settled to 1", () => {
    expect(xml).toContain('Is_Closed="1"');
    expect(xml).toContain('Is_Settled="1"');
  });
  it("uses the next tray number and marks the check not-new", () => {
    expect(xml).toContain('Tray_Number="2"');
    expect(xml).toContain('Is_New="0"');
  });
  it("emits Type=T tender lines with Tender_POS_ID, Change_Given and Line_Amount", () => {
    expect(xml).toContain('Type="T"');
    expect(xml).toContain("<Tender_POS_ID>1</Tender_POS_ID>");
    expect(xml).toContain("<Change_Given>3.00</Change_Given><Line_Amount>20.00</Line_Amount>");
  });
  it("carries gift balance in Transaction_Ref and the card ref in Reference", () => {
    expect(xml).toContain("<Transaction_Ref>12.00</Transaction_Ref><Reference>1234</Reference>");
  });
  it("does not re-send already-fired item lines", () => {
    expect(xml).not.toContain('Type="M"');
  });
});
