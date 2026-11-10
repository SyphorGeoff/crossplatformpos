// @vitest-environment jsdom
/*
 * Finalize protocol — Unfinalized_Tenders parse (server Check.getUnfinalizedXML
 * shape) and the Finalize_Tender post (iOS CreditCardManager finalizeTender,
 * server Transactional_Request.finalizetender + Check.finalizeTender).
 */

import { describe, expect, it } from "vitest";
import { buildFinalizeTender, parseUnfinalized, refNoField } from "@/protocol/finalize";
import { parseXmlResponse } from "@/protocol/hbroker";
import type { SessionConfig } from "@/protocol/order";

const cfg: SessionConfig = { enterpriseServerUrl: "https://enox.aireus.com", isisVer: "1.0", storeId: "3", token: "TOK", terminalPosId: "28" };

const LIST = `<?xml version="1.0"?><Unfinalized_Tenders>
<Unfinalized_Tender><ISIS_Ver>1.0</ISIS_Ver><Store_ID>3</Store_ID><BusinessDate_ID>90042</BusinessDate_ID><Check_Number>280001</Check_Number><check_key>1234567</check_key>
<Check_Name>T12</Check_Name><Table_POS_ID>4</Table_POS_ID><Emp_POS_ID>5</Emp_POS_ID><RevenueCenter_POS_ID>1</RevenueCenter_POS_ID>
<Tray_Number>2</Tray_Number><Line_Item_Ref_ID>3</Line_Item_Ref_ID><Tender_POS_ID>16</Tender_POS_ID><Base_Amount>42.50</Base_Amount>
<RefNo>MKABC1</RefNo><RecordNo>MKABC1</RecordNo><AuthCode>OK1007</AuthCode><TruncatedAcctNo>XXXXXXXXXXXX6781</TruncatedAcctNo><AcctNo>XXXXXXXXXXXX6781</AcctNo></Unfinalized_Tender>
<Unfinalized_Tender><Check_Number>280002</Check_Number><check_key>7654321</check_key><Emp_POS_ID>9</Emp_POS_ID><Tray_Number>1</Tray_Number><Line_Item_Ref_ID>2</Line_Item_Ref_ID><Tender_POS_ID>16</Tender_POS_ID><Base_Amount>10</Base_Amount><RefNo>MKDEF2</RefNo></Unfinalized_Tender>
</Unfinalized_Tenders>`;

describe("parseUnfinalized", () => {
  it("reads every card field the server lists", () => {
    const rows = parseUnfinalized(parseXmlResponse(LIST));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      checkNo: "280001", checkKey: "1234567", checkName: "T12", tableId: "4", businessDateId: "90042", empPosId: "5", revenueCenterId: "1",
      trayNumber: 2, lineNumber: 3, tenderId: "16", baseAmount: 42.5, refNo: "MKABC1", recordNo: "MKABC1", authCode: "OK1007", last4: "6781",
    });
    expect(rows[1]).toMatchObject({ checkNo: "280002", empPosId: "9", baseAmount: 10, last4: "" });
  });
  it("an empty list parses to []", () => {
    expect(parseUnfinalized(parseXmlResponse("<Unfinalized_Tenders></Unfinalized_Tenders>"))).toEqual([]);
  });
});

describe("refNoField", () => {
  it("builds the 5-part :ZZ: form with A for untouched fields", () => {
    expect(refNoField({ ref: "R1", recordNo: "C1", authCode: "OK1" })).toBe("R1:ZZ:C1:ZZ:OK1:ZZ:A:ZZ:A");
    expect(refNoField({ ref: "R1" })).toBe("R1:ZZ:R1:ZZ:A:ZZ:A:ZZ:A");
  });
});

describe("buildFinalizeTender", () => {
  const xml = buildFinalizeTender(cfg, { tip: 8.5, lineNumber: 3, trayNumber: 2, checkNo: "280001", checkKey: "1234567", businessDateId: "90042", ref: "MKABC1", recordNo: "MKABC1", authCode: "OK1007", authEmpId: "77" });
  it("uses the Finalize_Tender DTD with the Post_Message root, as the iPad does", () => {
    expect(xml).toContain('<!DOCTYPE Finalize_Tender SYSTEM "Transactions/Post_Messages/Finalize_Tender.dtd"><Post_Message>');
    expect(xml.endsWith("</Post_Message>")).toBe(true);
  });
  it("carries the identity, the tip, the line reference and the authorizer", () => {
    for (const frag of ["<ISIS_Ver>1.0</ISIS_Ver>", "<Store_ID>3</Store_ID>", "<Security_Token>TOK</Security_Token>", "<Tip_Amount>8.50</Tip_Amount>",
      "<Line_Item_Ref_ID>3</Line_Item_Ref_ID>", "<Check_Number>280001</Check_Number>", "<check_key>1234567</check_key>", "<Tray_Number>2</Tray_Number>",
      "<BusinessDate_ID>90042</BusinessDate_ID>", "<Authorizing_Emp_POS_ID>77</Authorizing_Emp_POS_ID>"]) expect(xml).toContain(frag);
  });
  it("sends RefNo in the 5-part form so the server updates RefNo/RecordNo/AuthCode whatever hostbased_cc says", () => {
    expect(xml).toContain("<RefNo>MKABC1:ZZ:MKABC1:ZZ:OK1007:ZZ:A:ZZ:A</RefNo>");
  });
  it("omits RefNo and the authorizer when not given", () => {
    const x = buildFinalizeTender(cfg, { tip: 0, lineNumber: 1, trayNumber: 1, checkNo: "1", checkKey: "2", businessDateId: "3" });
    expect(x).not.toContain("<RefNo>"); expect(x).not.toContain("Authorizing_Emp_POS_ID"); expect(x).toContain("<Tip_Amount>0.00</Tip_Amount>");
  });
});
