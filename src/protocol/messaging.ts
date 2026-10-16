/*
 * Messaging — the store's outbound SMS/email channel (MessagingManager.m:201).
 * Root <Post_Message> (Post_Messages/Post_Message.dtd), POSTed to the same
 * /ISISPOS/HBroker endpoint. Text Check (CheckViewController didPhoneEnter:) sets
 * Send_SMS=1 with the guest's phone and a Message_Body that is a "getcheckhtml"
 * link to the web receipt (mobile/aireuspay). Success = Status_Code=="100".
 */

import { apiServerAddress, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
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

/* =====================================================================
 * Inbox (messaging arc F1/F2, MESSAGING_API.md §3–§4; iOS MessagingManager.m)
 * ===================================================================== */

const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';
const READ_DTD = '<!DOCTYPE Mark_Messages_Read SYSTEM "Transactions/Post_Messages/Mark_Messages_Read.dtd">';

/** One inbox message as the `Messages` fetch returns it (Message.java:128-164). */
export interface InboxMessage {
  id: string;             // Message_ID
  fromEmpId: string;      // From_Employee_POS_ID
  fromName: string;       // From_Employee_Name ("Last,First") when the sender is a known employee, else ""
  toEmpId: string;
  subject: string;
  body: string;
  sentOn: string;         // Sent_On as the sender stamped it
  localNotified: boolean; // LocalNotified "1" — a device already popped it
  eventId: string;
  checkId: string;
}

/** Fetch my unread messages (MessagingManager.m:95-100). `type`/`source` = the
 *  LocalNotified variant (:180-186). Byte order matches iOS. */
export function messagesRequestXml(cfg: SessionConfig, empPosId: string, opts: { type?: string; source?: string } = {}): string {
  const extra = opts.type ? el("type", opts.type) + el("Source", opts.source ?? "") : "";
  return `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Messages">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Emp_POS_ID", empPosId) + extra + `</Transactional_Request>`;
}

/** Parse `<Messages><Message>…</Message>…</Messages>`. Tolerates the empty reply
 *  (`<Messages></Messages>`), ISIS_Version vs ISIS_Ver, and the two element
 *  orders the server emits. A Message_Status reply (e.g. 400 Invalid Token) throws. */
export function parseMessagesXml(xml: string): InboxMessage[] {
  const parsed = parseXmlResponse(xml);
  const status = findKey(parsed, "Message_Status");
  if (status !== undefined) {
    const code = textOf(findKey(parsed, "Status_Code"));
    const text = textOf(findKey(parsed, "Status_Text"));
    if (code !== "100") throw new Error(`${text || "server error"} (${code || "?"})`);
    return [];
  }
  const rows = findKey(parsed, "Message");
  const list = Array.isArray(rows) ? rows : rows && typeof rows !== "string" ? [rows] : [];
  return list
    .filter((r): r is XmlDict => typeof r !== "string")
    .map((r) => {
      const g = (k: string) => textOf(findKey(r, k));
      return {
        id: g("Message_ID"), fromEmpId: g("From_Employee_POS_ID"), fromName: g("From_Employee_Name"),
        toEmpId: g("To_Employee_POS_ID"), subject: g("Subject"), body: g("Message_Body"), sentOn: g("Sent_On"),
        localNotified: g("LocalNotified") === "1", eventId: g("Event_ID"), checkId: g("Check_ID"),
      };
    })
    .filter((m) => m.id);
}

export async function fetchMessages(cfg: SessionConfig, empPosId: string): Promise<InboxMessage[]> {
  return parseMessagesXml(await postXml(apiServerAddress(cfg.enterpriseServerUrl), messagesRequestXml(cfg, empPosId)));
}

/** Tell the server a device has popped this message (iOS :171-195). Fire and forget. */
export async function setLocalNotified(cfg: SessionConfig, empPosId: string, messageId: string): Promise<void> {
  try { await postXml(apiServerAddress(cfg.enterpriseServerUrl), messagesRequestXml(cfg, empPosId, { type: "LocalNotified", source: messageId })); }
  catch { /* best effort */ }
}

/** Mark one message read (MessagingManager.m:378-383): one Message_ID per request,
 *  no Emp_POS_ID. The server processes only the first ID it finds. */
export function markReadXml(cfg: SessionConfig, messageId: string): string {
  return `${XML_HEAD}${READ_DTD}<Mark_Messages_Read>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Message_ID", messageId) + `</Mark_Messages_Read>`;
}

export async function markRead(cfg: SessionConfig, messageId: string): Promise<MessageResult> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), markReadXml(cfg, messageId)));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** Generic send (MessagingManager.m sendMessage :201-258), exact iOS element order:
 *  ISIS_Ver, Store_ID, Security_Token, Send_Email[+Email_Address] | Send_Email 0,
 *  Send_SMS[+Phone_Number] | Send_SMS 0, From, [To + Send_Internal 1], Subject, Body, Sent_On. */
export interface OutgoingMessage { fromEmpId: string; toEmpId?: string; email?: string; phone?: string; subject: string; body: string; }
export function postMessageXml(cfg: SessionConfig, p: OutgoingMessage, now = new Date()): string {
  const email = p.email?.trim() ? el("Send_Email", "1") + el("Email_Address", p.email.trim()) : el("Send_Email", "0");
  const sms = p.phone?.trim() ? el("Send_SMS", "1") + el("Phone_Number", p.phone.trim()) : el("Send_SMS", "0");
  const to = p.toEmpId ? el("To_Employee_POS_ID", p.toEmpId) + el("Send_Internal", "1") : "";
  return `${XML_HEAD}${DTD}<Post_Message>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    email + sms + el("From_Employee_POS_ID", p.fromEmpId) + to +
    el("Subject", p.subject) + el("Message_Body", p.body) + el("Sent_On", stamp(now)) + `</Post_Message>`;
}

/** Send result; `ids` / `smsResult` arrive once the server returns them (arc F8). */
export interface SendResult extends MessageResult { ids: string[]; smsResult: string; }
export async function sendMessage(cfg: SessionConfig, p: OutgoingMessage): Promise<SendResult> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), postMessageXml(cfg, p)));
    const code = textOf(findKey(parsed, "Status_Code"));
    const ids = textOf(findKey(parsed, "Message_IDs")).split(",").map((s) => s.trim()).filter(Boolean);
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response", ids, smsResult: textOf(findKey(parsed, "SMS_Result")) };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, ids: [], smsResult: "" }; }
}

/* =====================================================================
 * Broadcasts — the store-wide notice board (messaging arc F4). Server side:
 * Post_Message + Broadcast=1 (+Expires_On, Terminal_POS_ID); fetch with
 * Trans_Type=Messages type=Broadcast (no Emp_POS_ID); ClearBroadcast records the
 * FIRST terminal to clear (the hide itself is per terminal, on the device);
 * RemoveBroadcast = the sender takes it down for everyone.
 * ===================================================================== */

export interface BroadcastNotice extends InboxMessage {
  terminalPosId: string;  // sender terminal / KDS station (display)
  expiresOn: string;      // "yyyy-MM-dd HH:mm:ss" server clock
  ackTerminal: string;    // first terminal that cleared it ("" = unseen)
  ackAt: string;
  broadcast: boolean;     // the server marked it Broadcast=1 (only the updated server does)
}

function parseBroadcastsXml(xml: string): BroadcastNotice[] {
  const parsed = parseXmlResponse(xml);
  if (findKey(parsed, "Message_Status") !== undefined) {
    const code = textOf(findKey(parsed, "Status_Code"));
    if (code !== "100") throw new Error(`${textOf(findKey(parsed, "Status_Text")) || "server error"} (${code || "?"})`);
    return [];
  }
  const rows = findKey(parsed, "Message");
  const list = Array.isArray(rows) ? rows : rows && typeof rows !== "string" ? [rows] : [];
  return list.filter((r): r is XmlDict => typeof r !== "string").map((r) => {
    const g = (k: string) => textOf(findKey(r, k));
    return {
      id: g("Message_ID"), fromEmpId: g("From_Employee_POS_ID"), fromName: g("From_Employee_Name"), toEmpId: g("To_Employee_POS_ID"),
      subject: g("Subject"), body: g("Message_Body"), sentOn: g("Sent_On"), localNotified: g("LocalNotified") === "1",
      eventId: g("Event_ID"), checkId: g("Check_ID"),
      terminalPosId: g("Terminal_POS_ID"), expiresOn: g("Expires_On"), ackTerminal: g("Ack_Terminal"), ackAt: g("Ack_At"),
      broadcast: g("Broadcast") === "1",
    };
  }).filter((m) => m.id && m.broadcast); // an un-updated server answers with the plain message list — ignore it
}

/** `Trans_Type=Messages` with `type` and no Emp_POS_ID (broadcast lane). */
export function broadcastRequestXml(cfg: SessionConfig, type: "Broadcast" | "ClearBroadcast" | "RemoveBroadcast", source = ""): string {
  return `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Messages">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Terminal_POS_ID", cfg.terminalPosId) + el("type", type) + (source ? el("Source", source) : "") + `</Transactional_Request>`;
}

export async function fetchBroadcasts(cfg: SessionConfig): Promise<BroadcastNotice[]> {
  return parseBroadcastsXml(await postXml(apiServerAddress(cfg.enterpriseServerUrl), broadcastRequestXml(cfg, "Broadcast")));
}

/** Per-terminal clear: hides locally on the caller's side; the server records only the first. */
export async function clearBroadcast(cfg: SessionConfig, id: string): Promise<void> {
  try { await postXml(apiServerAddress(cfg.enterpriseServerUrl), broadcastRequestXml(cfg, "ClearBroadcast", id)); } catch { /* best effort */ }
}

/** The sender takes a notice down for everyone. */
export async function removeBroadcast(cfg: SessionConfig, id: string): Promise<MessageResult> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), broadcastRequestXml(cfg, "RemoveBroadcast", id)));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** Post a store-wide notice (Broadcast=1). `minutes` = lifetime (default 10). */
export function broadcastPostXml(cfg: SessionConfig, p: { fromEmpId?: string; subject: string; body: string; minutes?: number }, now = new Date()): string {
  const exp = new Date(now.getTime() + (p.minutes ?? 10) * 60_000);
  return `${XML_HEAD}${DTD}<Post_Message>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Send_Email", "0") + el("Send_SMS", "0") + el("From_Employee_POS_ID", p.fromEmpId ?? "") +
    el("Broadcast", "1") + el("Terminal_POS_ID", cfg.terminalPosId) +
    el("Subject", p.subject) + el("Message_Body", p.body) + el("Sent_On", stamp(now)) + el("Expires_On", stamp(exp)) + `</Post_Message>`;
}

export async function sendBroadcast(cfg: SessionConfig, p: { fromEmpId?: string; subject: string; body: string; minutes?: number }): Promise<SendResult> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), broadcastPostXml(cfg, p)));
    const code = textOf(findKey(parsed, "Status_Code"));
    const ids = textOf(findKey(parsed, "Message_IDs")).split(",").map((s) => s.trim()).filter(Boolean);
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response", ids, smsResult: "" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, ids: [], smsResult: "" }; }
}
