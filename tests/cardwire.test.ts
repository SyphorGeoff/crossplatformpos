// @vitest-environment jsdom
/*
 * Card fields on the wire — a processor card line is a Type="T" LineItem with
 * Finalized="0"/"1" and RefNo / RecordNo / AuthCode / masked account elements
 * (iPad lineItemtoString, server Check LineItem), and the pull-back parser
 * restores them. Cash / offline card lines are unchanged.
 */

import { describe, expect, it } from "vitest";
import { addTender, isCardLine, isUncapturedCard, newCheck, type Check, type TenderLine } from "@/model/check";
import { buildFinancialCheck, maskedAcct, type SendContext } from "@/protocol/order";
import { parseCheckLines } from "@/protocol/tables";
import { parseXmlResponse, findKey, type XmlDict } from "@/protocol/hbroker";

const ctx: SendContext = { isisVer: "1.0", storeId: "3", securityToken: "TOK", terminalPosId: "28", employeePosId: "5", businessDateId: "90042", checkNo: "280001" };
const base = (): Check => ({ id: "1234567", revenueCenterId: "1", tableName: "T1", guestCount: 1, openedAt: 0, traysSent: 1, tenders: [],
  lines: [{ key: "a", menuItemId: "100", description: "Burger", quantity: 1, amount: 12, kind: "M", indentLevel: 0, sent: true, trayNumber: 1, lineNumber: 1 }] });

const tenderXml = (c: Check) => buildFinancialCheck(c, ctx).match(/<LineItem[^>]*Type="T"[^>]*>.*?<\/LineItem>/g) ?? [];

describe("xmlTenderLine card fields", () => {
  it("an authorized card line: Finalized=0 with RefNo / RecordNo / AuthCode / masked account", () => {
    const c = addTender(base(), { key: "7654321", tenderId: "16", name: "Auth CC", amount: 12, tip: 0, change: 0, ref: "MKABC1", recordNo: "MKABC1", authCode: "OK1007", last4: "6781", finalized: false, processor: "mock" });
    const [t] = tenderXml(c);
    expect(t).toContain('Type="T" Finalized="0"');
    expect(t).toContain('lineitemkey="7654321"');
    expect(t).toContain("<TruncatedAcctNo>XXXXXXXXXXXX6781</TruncatedAcctNo><RecordNo>MKABC1</RecordNo><AuthCode>OK1007</AuthCode><RefNo>MKABC1</RefNo><AcctNo>XXXXXXXXXXXX6781</AcctNo><Line_Amount>12.00</Line_Amount>");
  });
  it("a one-shot sale is Finalized=1 with its tip", () => {
    const c = addTender(base(), { tenderId: "16", name: "Auth CC", amount: 12, tip: 2, change: 0, ref: "MKX", finalized: true });
    const [t] = tenderXml(c);
    expect(t).toContain('Finalized="1"'); expect(t).toContain("<Tip_Amount>2.00</Tip_Amount>"); expect(t).toContain("<RefNo>MKX</RefNo>");
    expect(t).not.toContain("TruncatedAcctNo"); expect(t).not.toContain("AuthCode");
  });
  it("cash and offline cards are untouched: Finalized=1 and no card elements", () => {
    const c = addTender(base(), { tenderId: "1", name: "Cash", amount: 12, tip: 0, change: 3 });
    const [t] = tenderXml(c);
    expect(t).toContain('Finalized="1"'); expect(t).not.toContain("RefNo"); expect(t).toContain("<Change_Given>3.00</Change_Given>");
  });
  it("maskedAcct keeps only the last four", () => { expect(maskedAcct("1234567890")).toBe("XXXXXXXXXXXX7890"); });
  it("addTender keeps a caller-minted key (the processor already knows it) and mints otherwise", () => {
    const c = addTender(addTender(base(), { key: "7654321", tenderId: "16", name: "x", amount: 1, tip: 0, change: 0 }), { tenderId: "1", name: "Cash", amount: 1, tip: 0, change: 0 });
    expect(c.tenders[0].key).toBe("7654321"); expect(c.tenders[1].key).toMatch(/^\d{7}$/);
  });
});

const PULL = `<?xml version="1.0"?><FinancialCheck Check_Name="T1" Guest_Count="1"><check_key>1234567</check_key>
<Tray Tray_Number="1" Sent_On="2026-11-05 10:00:00"><LineItem Type="M" Is_Void="0"><Quantity>1</Quantity><Line_Number>1</Line_Number><MenuItem_POS_ID>100</MenuItem_POS_ID><Line_Amount>12.00</Line_Amount></LineItem></Tray>
<Tray Tray_Number="2" Sent_On="2026-11-05 10:05:00">
<LineItem Type="T" Is_Void="0" Finalized="0"><Quantity>1</Quantity><Line_Number>1</Line_Number><Tender_POS_ID>16</Tender_POS_ID><TruncatedAcctNo>XXXXXXXXXXXX6781</TruncatedAcctNo><RecordNo>MKABC1</RecordNo><AuthCode>OK1007</AuthCode><RefNo>MKABC1</RefNo><AcctNo>XXXXXXXXXXXX6781</AcctNo><Line_Amount>12.00</Line_Amount></LineItem>
<LineItem Type="T" Is_Void="0" Finalized="1"><Quantity>1</Quantity><Line_Number>2</Line_Number><Tender_POS_ID>3</Tender_POS_ID><Tip_Amount>2.00</Tip_Amount><RefNo>MKSALE</RefNo><RecordNo>0</RecordNo><Line_Amount>10.00</Line_Amount></LineItem>
<LineItem Type="T" Is_Void="0" Finalized="1"><Quantity>1</Quantity><Line_Number>3</Line_Number><Tender_POS_ID>1</Tender_POS_ID><RefNo>0</RefNo><Change_Given>1.00</Change_Given><Line_Amount>5.00</Line_Amount></LineItem>
</Tray></FinancialCheck>`;

describe("parseCheckLines card fields", () => {
  const fc = findKey(parseXmlResponse(PULL), "FinancialCheck") as XmlDict;
  const names = { menuItemName: () => "Burger", tenderName: (id: string) => ({ "16": "Auth CC", "3": "Visa", "1": "Cash" })[id] ?? id };
  const { tenders } = parseCheckLines(fc, names);
  it("restores an uncaptured auth with its ids and masked account", () => {
    const t = tenders.find((x) => x.tenderId === "16") as TenderLine;
    expect(t).toMatchObject({ ref: "MKABC1", recordNo: "MKABC1", authCode: "OK1007", last4: "6781", finalized: false, authorizedAmount: 12, amount: 12, sent: true, trayNumber: 2, lineNumber: 1 });
    expect(isUncapturedCard(t)).toBe(true); expect(isCardLine(t)).toBe(true);
  });
  it("restores a captured sale (RecordNo 0 falls back to RefNo)", () => {
    const t = tenders.find((x) => x.tenderId === "3") as TenderLine;
    expect(t).toMatchObject({ ref: "MKSALE", recordNo: "MKSALE", finalized: true, capturedAmount: 10, tip: 2 });
    expect(isUncapturedCard(t)).toBe(false);
  });
  it("a cash line with the server's RefNo 0 is not a card line", () => {
    const t = tenders.find((x) => x.tenderId === "1") as TenderLine;
    expect(t.ref).toBeUndefined(); expect(t.finalized).toBeUndefined(); expect(isCardLine(t)).toBe(false); expect(t.change).toBe(1);
  });
});

describe("newCheck", () => { it("starts with no tenders", () => expect(newCheck("1").tenders).toEqual([])); });
