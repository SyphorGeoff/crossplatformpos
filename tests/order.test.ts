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
  it("links the modifier to its parent's Line_Number and Tray", () => {
    // modifier b is line 2, parent a is line 1, tray 1
    expect(xml).toContain("<Parent_LineItem_ID>1</Parent_LineItem_ID><Parent_Tray_Number>1</Parent_Tray_Number>");
    expect(xml).toContain("<Line_Number>2</Line_Number><MenuItem_POS_ID>200</MenuItem_POS_ID>");
  });
  it("excludes already-sent lines (only the unsent round is fired)", () => {
    expect(xml).not.toContain("<MenuItem_POS_ID>300</MenuItem_POS_ID>");
  });
});
