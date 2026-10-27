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

// ---- inbox (messaging arc F1/F2) — byte-for-byte against MessagingManager.m ----
import { markReadXml, messagesRequestXml, postMessageXml } from "@/protocol/messaging";

const cfg = { enterpriseServerUrl: "https://x", isisVer: "ver 1.0.0", storeId: "3", token: "TOK", terminalPosId: "21" };

describe("messagesRequestXml (MessagingManager.m:95-100 / :180-186)", () => {
  it("fetch: Trans_Type=Messages with ISIS_Ver, Store_ID, Security_Token, Emp_POS_ID and nothing else", () => {
    expect(messagesRequestXml(cfg, "9999")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd"><Transactional_Request Trans_Type="Messages"><ISIS_Ver>ver 1.0.0</ISIS_Ver><Store_ID>3</Store_ID><Security_Token>TOK</Security_Token><Emp_POS_ID>9999</Emp_POS_ID></Transactional_Request>',
    );
  });
  it("LocalNotified: adds <type>LocalNotified</type><Source>{id}</Source>", () => {
    expect(messagesRequestXml(cfg, "9999", { type: "LocalNotified", source: "123" })).toContain(
      "<Emp_POS_ID>9999</Emp_POS_ID><type>LocalNotified</type><Source>123</Source></Transactional_Request>",
    );
  });
});

describe("markReadXml (MessagingManager.m:378-383)", () => {
  it("one Message_ID, no Emp_POS_ID", () => {
    expect(markReadXml(cfg, "123")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Mark_Messages_Read SYSTEM "Transactions/Post_Messages/Mark_Messages_Read.dtd"><Mark_Messages_Read><ISIS_Ver>ver 1.0.0</ISIS_Ver><Store_ID>3</Store_ID><Security_Token>TOK</Security_Token><Message_ID>123</Message_ID></Mark_Messages_Read>',
    );
  });
});

describe("postMessageXml (MessagingManager.m sendMessage :201-258 element order)", () => {
  const at = new Date(2026, 9, 16, 19, 42, 5);
  it("internal: Send_Email 0, Send_SMS 0, From, To + Send_Internal 1, Subject, Body, Sent_On", () => {
    expect(postMessageXml(cfg, { fromEmpId: "1", toEmpId: "5", subject: "Hi", body: "There" }, at)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Post_Message SYSTEM "Transactions/Post_Messages/Post_Message.dtd"><Post_Message><ISIS_Ver>ver 1.0.0</ISIS_Ver><Store_ID>3</Store_ID><Security_Token>TOK</Security_Token><Send_Email>0</Send_Email><Send_SMS>0</Send_SMS><From_Employee_POS_ID>1</From_Employee_POS_ID><To_Employee_POS_ID>5</To_Employee_POS_ID><Send_Internal>1</Send_Internal><Subject>Hi</Subject><Message_Body>There</Message_Body><Sent_On>2026-10-16 19:42:05</Sent_On></Post_Message>',
    );
  });
  it("email: Send_Email 1 + Email_Address before Send_SMS 0; no Send_Internal element at all", () => {
    const xml = postMessageXml(cfg, { fromEmpId: "1", email: "a@b.c", subject: "S", body: "B" }, at);
    expect(xml).toContain("<Security_Token>TOK</Security_Token><Send_Email>1</Send_Email><Email_Address>a@b.c</Email_Address><Send_SMS>0</Send_SMS><From_Employee_POS_ID>1</From_Employee_POS_ID><Subject>S</Subject>");
    expect(xml).not.toContain("Send_Internal");
  });
  it("text: Send_SMS 1 + Phone_Number", () => {
    expect(postMessageXml(cfg, { fromEmpId: "1", phone: "5555551234", subject: "", body: "B" }, at)).toContain(
      "<Send_Email>0</Send_Email><Send_SMS>1</Send_SMS><Phone_Number>5555551234</Phone_Number><From_Employee_POS_ID>1</From_Employee_POS_ID><Subject></Subject><Message_Body>B</Message_Body>",
    );
  });
});

// ---- broadcast lane (messaging arc F4) ----
import { broadcastPostXml, broadcastRequestXml } from "@/protocol/messaging";

describe("broadcast lane", () => {
  it("fetch: Trans_Type=Messages, Terminal_POS_ID, type=Broadcast, no Emp_POS_ID", () => {
    expect(broadcastRequestXml(cfg, "Broadcast")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd"><Transactional_Request Trans_Type="Messages"><ISIS_Ver>ver 1.0.0</ISIS_Ver><Store_ID>3</Store_ID><Security_Token>TOK</Security_Token><Terminal_POS_ID>21</Terminal_POS_ID><type>Broadcast</type></Transactional_Request>',
    );
  });
  it("clear: type=ClearBroadcast + Source", () => {
    expect(broadcastRequestXml(cfg, "ClearBroadcast", "77")).toContain("<type>ClearBroadcast</type><Source>77</Source></Transactional_Request>");
  });
  it("post: Broadcast=1, Terminal_POS_ID, Expires_On = now + minutes", () => {
    const xml = broadcastPostXml(cfg, { subject: "Running behind", body: "15 min on entrées", minutes: 10 }, new Date(2026, 9, 16, 19, 38, 0));
    expect(xml).toContain("<Send_Email>0</Send_Email><Send_SMS>0</Send_SMS><From_Employee_POS_ID></From_Employee_POS_ID><Broadcast>1</Broadcast><Terminal_POS_ID>21</Terminal_POS_ID><Subject>Running behind</Subject><Message_Body>15 min on entrées</Message_Body><Sent_On>2026-10-16 19:38:00</Sent_On><Expires_On>2026-10-16 19:48:00</Expires_On></Post_Message>");
  });
});

// ---- Email Check (MessagingManager.m sendEmailCheckMessage :280-320) ----
import { emailCheckXml } from "@/protocol/messaging";
describe("emailCheckXml", () => {
  it("Send_Email=1 with Check_ID / BusinessDate_ID / check_key, in the iPad's order; 'to|cc' carries a CC", () => {
    const xml = emailCheckXml(cfg, { email: "a@x.com|b@x.com", empPosId: "1", checkNo: "210035", businessDateId: "90103", checkKey: "9872281" }, new Date(2026, 9, 27, 9, 5, 7));
    expect(xml).toContain("<Security_Token>TOK</Security_Token><Send_Email>1</Send_Email><From_Employee_POS_ID>1</From_Employee_POS_ID><Send_Internal>0</Send_Internal><Check_ID>210035</Check_ID><BusinessDate_ID>90103</BusinessDate_ID><CC_Email_Address>b@x.com</CC_Email_Address><Email_Address>a@x.com</Email_Address><check_key>9872281</check_key><Sent_On>2026-10-27 09:05:07</Sent_On></Post_Message>");
    expect(emailCheckXml(cfg, { email: "a@x.com", empPosId: "1", checkNo: "1", businessDateId: "2", checkKey: "3" })).not.toContain("CC_Email_Address");
  });
});
