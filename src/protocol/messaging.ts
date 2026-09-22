/*
 * Messaging — the store's outbound SMS/email channel (MessagingManager.m:201).
 * Root <Post_Message> (Post_Messages/Post_Message.dtd), POSTed to the same
 * /ISISPOS/HBroker endpoint. Text Check (CheckViewController didPhoneEnter:) sets
 * Send_SMS=1 with the guest's phone and a Message_Body that is a "getcheckhtml"
 * link to the web receipt (mobile/aireuspay). Success = Status_Code=="100".
 */

import { apiServerAddress, findKey, parseXmlResponse, postXml, textOf } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const DTD = '<!DOCTYPE Post_Message SYSTEM "Transactions/Post_Messages/Post_Message.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

/** Two-digit datetime stamp "yyyy-MM-dd HH:mm:ss" (Sent_On). */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The web-receipt link an SMS/email carries (CheckViewController.m:33382). The
 *  host is the store's image server, forced to https with the port stripped;
 *  `host=<enterpriseCode>` selects the enterprise on the receipt server. */
export function checkHtmlUrl(p: {
  imageServerUrl: string; enterpriseId: string; enterpriseCode: string;
  storeId: string; token: string; businessDateId: string; checkNo: string; checkKey: string;
}): string {
  const base = (p.imageServerUrl && p.imageServerUrl.length ? p.imageServerUrl : "http://images.isispos.com:8080")
    .replace(/^http:/i, "https:").replace(/:\d+/, "");
  const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`;
  return `${base}/mobile/aireuspay/?` + [
    q("enterpriseID", p.enterpriseId), q("Store_ID", p.storeId), q("Security_Token", p.token),
    "TransType=getcheckhtml", q("BusinessDate_ID", p.businessDateId), q("Check_No", p.checkNo),
    q("check_key", p.checkKey), q("host", p.enterpriseCode),
  ].join("&");
}

export interface MessageResult { ok: boolean; message: string; }

/** Text the check to a phone (Send_SMS=1). `body` is typically checkHtmlUrl(). */
export async function sendTextCheck(cfg: SessionConfig, p: { phone: string; empPosId: string; body: string }): Promise<MessageResult> {
  const xml = `${XML_HEAD}${DTD}<Post_Message>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Send_Email", "0") + `<Email_Address></Email_Address>` +
    el("Send_SMS", "1") + el("Phone_Number", p.phone) +
    el("From_Employee_POS_ID", p.empPosId) + `<Subject></Subject>` + el("Message_Body", p.body) +
    el("Sent_On", stamp()) + `</Post_Message>`;
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
    const code = textOf(findKey(parsed, "Status_Code"));
    const text = textOf(findKey(parsed, "Status_Text"));
    return { ok: code === "100", message: text || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** Internal message to another employee (MessagingManager.m sendMessage :200-240 with a
 *  "recipient"): no email/SMS, To_Employee_POS_ID + Send_Internal=1. Transfer Check sends
 *  Subject "CheckTransfer" / "Table 13 was transferred to you!" to the new owner. */
export function employeeNoticeXml(cfg: SessionConfig, p: { fromEmpId: string; toEmpId: string; subject: string; body: string }, now = new Date()): string {
  return `${XML_HEAD}${DTD}<Post_Message>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Send_Email", "0") + el("Send_SMS", "0") +
    el("From_Employee_POS_ID", p.fromEmpId) + el("To_Employee_POS_ID", p.toEmpId) + el("Send_Internal", "1") +
    el("Subject", p.subject) + el("Message_Body", p.body) + el("Sent_On", stamp(now)) + `</Post_Message>`;
}

export async function sendEmployeeNotice(cfg: SessionConfig, p: { fromEmpId: string; toEmpId: string; subject: string; body: string }): Promise<MessageResult> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), employeeNoticeXml(cfg, p)));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}
