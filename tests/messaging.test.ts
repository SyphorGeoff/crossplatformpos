import { describe, expect, it } from "vitest";
import { employeeNoticeXml } from "@/protocol/messaging";

describe("employeeNoticeXml (internal transfer notice)", () => {
  it("is a Post_Message to the new owner with Send_Internal=1 and no email/SMS", () => {
    const cfg = { enterpriseServerUrl: "https://x", isisVer: "1", storeId: "3", token: "T", terminalPosId: "20" };
    const xml = employeeNoticeXml(cfg, { fromEmpId: "1", toEmpId: "5", subject: "CheckTransfer", body: "Table 13 was transferred to you!" }, new Date(2026, 8, 16, 10, 5, 7));
    expect(xml).toContain("<Send_Email>0</Send_Email><Send_SMS>0</Send_SMS>");
    expect(xml).toContain("<From_Employee_POS_ID>1</From_Employee_POS_ID><To_Employee_POS_ID>5</To_Employee_POS_ID><Send_Internal>1</Send_Internal>");
    expect(xml).toContain("<Subject>CheckTransfer</Subject><Message_Body>Table 13 was transferred to you!</Message_Body><Sent_On>2026-09-16 10:05:07</Sent_On>");
  });
});
