/*
 * Send-to-kitchen — the FinancialCheck POST that fires an order to the server,
 * which routes it to the kitchen displays/printers (by RevenueCenter + each
 * item's print groups, server-side). Faithful to the shipped iPad:
 *   FinancialCheckManager.m xmlCheckPost :12841-13054, xmlTray :13097-13158,
 *   lineItemtoString: :12244-12487, parsePostCheckResponse: :13058-13095.
 * POST to {enterprise}/ISISPOS/HBroker, Content-type text/xml.
 * Success = <Message_Status Status_Code="100">.
 *
 * A "tray" is one service round (a batch fired together). We fire the check's
 * unsent lines as a single tray; modifiers ride as their own Type="M" lines
 * carrying Parent_LineItem_ID + Parent_Tray_Number pointing at the parent's
 * Line_Number/Tray_Number. Line prices are per-line (Line_Amount), never rolled
 * into the parent.
 */

import { apiServerAddress, asList, findKey, parseXmlResponse, postXml, textOf } from "./hbroker";
import { unsentLines, unsentTenders, type Check, type CheckLine, type TenderLine } from "@/model/check";

export interface SessionConfig {
  enterpriseServerUrl: string;
  isisVer: string;
  storeId: string;
  token: string;
  terminalPosId: string;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const DTD = '<!DOCTYPE FinancialCheck SYSTEM "Transactions/Post_Messages/FinancialCheck.dtd">';

/** iPad escaping (DefinitionManager.m:2747-2748 then lineItemtoString:12463):
 *  & → &amp;, ' → &apos;, newline → &#xA;. Order matters (& first). */
export function escapeXml(v: string): string {
  return String(v).replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/\n/g, "&#xA;");
}

/** yyyy-MM-dd HH:mm:ss local — the iPad's getDateTime format everywhere. */
export function dateTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Client idempotency key (generateCheckKey analog) — GUID-ish, unique per key. */
export function mintCheckKey(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `k-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface SendContext {
  isisVer: string;
  storeId: string;
  securityToken: string;
  terminalPosId: string;
  employeePosId: string;
  businessDateId: string;   // required header field (see resolveBusinessDate)
  checkNo: string;          // client-assigned check number
  isToGo?: boolean;
}

const el = (name: string, value: string | number): string => `<${name}>${escapeXml(String(value))}</${name}>`;

/** One <LineItem …>. `lineNumber` map lets modifiers point at their parent. */
function xmlLineItem(line: CheckLine, lineNumber: number, trayNumber: number, parentLineNumber?: number): string {
  const attrs = [
    `Is_Held="${line.isVoid ? "0" : "0"}"`,
    `Is_Void="${line.isVoid ? "1" : "0"}"`,
    `Transfered_Out="0"`,
    `Print_On_Check="1"`,
    `Show_On_Display="1"`,
    `Type="M"`,
    `Finalized="0"`,
    `Is_Split="0"`,
    `lineitemkey="${escapeXml(line.key)}"`,
    `posted="0"`,
  ].join(" ");
  const parts: string[] = [];
  parts.push(el("Guest_Num", line.guestNumber ?? 1));
  if (line.kind === "Mo" && parentLineNumber !== undefined) {
    parts.push(el("Parent_LineItem_ID", parentLineNumber));
    parts.push(el("Parent_Tray_Number", trayNumber));
  }
  parts.push(el("Quantity", line.quantity));
  parts.push(el("Line_Number", lineNumber));
  parts.push(el("MenuItem_POS_ID", line.menuItemId));
  parts.push(el("Line_Amount", line.amount.toFixed(2)));
  return `<LineItem ${attrs}>${parts.join("")}</LineItem>`;
}

/** One <LineItem Type="T"> — a tender/payment (FinancialCheckManager.m:7224/12255). */
function xmlTenderLine(t: TenderLine, lineNumber: number): string {
  const attrs = [
    `Is_Held="0"`, `Is_Void="0"`, `Transfered_Out="0"`, `Print_On_Check="1"`,
    `Show_On_Display="0"`, `Type="T"`, `Finalized="1"`, `Is_Split="0"`,
    `lineitemkey="${escapeXml(t.key)}"`, `posted="0"`,
  ].join(" ");
  const parts: string[] = [];
  parts.push(el("Quantity", 1));
  parts.push(el("Line_Number", lineNumber));
  parts.push(el("Tender_POS_ID", t.tenderId));
  if (t.tip) parts.push(el("Tip_Amount", t.tip.toFixed(2)));
  if (t.change) parts.push(el("Change_Given", t.change.toFixed(2)));
  if (t.balanceRef) parts.push(el("Transaction_Ref", t.balanceRef));
  if (t.reference) parts.push(el("Reference", t.reference));
  parts.push(el("Line_Amount", t.amount.toFixed(2)));
  return `<LineItem ${attrs}>${parts.join("")}</LineItem>`;
}

/** The full FinancialCheck document for the check's unsent round (one tray).
 *  `settle` closes the check: adds the tender lines' round and flips Is_Closed /
 *  Is_Settled (settle is the same POST re-sent, not a separate message —
 *  FinancialCheckManager.m:13824/23664/7953). */
export function buildFinancialCheck(check: Check, ctx: SendContext, opts: { settle?: boolean } = {}, now = new Date()): string {
  const settle = opts.settle ?? false;
  const trayNumber = check.traysSent + 1;
  const stamp = dateTime(now);

  // Line_Number is tray-scoped: items first (so modifiers can reference their
  // parent's number within the tray), then tender lines.
  const items = unsentLines(check);
  const numberByKey = new Map<string, number>();
  items.forEach((l, i) => numberByKey.set(l.key, i + 1));
  const tenders = unsentTenders(check);

  const itemXml = items
    .map((l) => xmlLineItem(l, numberByKey.get(l.key)!, trayNumber, l.parentKey ? numberByKey.get(l.parentKey) : undefined))
    .join("");
  const tenderXml = tenders.map((t, i) => xmlTenderLine(t, items.length + i + 1)).join("");

  const tray =
    `<Tray Tray_Number="${trayNumber}" Terminal_POS_ID="${escapeXml(ctx.terminalPosId)}" ` +
    `Sent_On="${stamp}" Employee_POS_ID="${escapeXml(ctx.employeePosId)}" traykey="${mintCheckKey()}">` +
    itemXml + tenderXml + `</Tray>`;

  const flag = (b: boolean) => (b ? "1" : "0");
  const checkAttrs = [
    `Is_Cancelled="0"`, `Is_Return="0"`, `Print_Count="0"`, `Is_Transferred="0"`,
    `is_FutureOrder="0"`, `Is_Split="0"`, `Is_Tax_Exempt="0"`,
    `Guest_Count="${check.guestCount}"`, `Is_Closed="${flag(settle)}"`, `Is_Reopen="0"`,
    // is_Settled (lowercase) is always empty on the wire; Is_Settled carries the flag.
    `is_Settled=""`, `Is_Settled="${flag(settle)}"`,
    `Check_Name="${escapeXml(check.tableName || "")}"`, `Is_New="${flag(check.traysSent === 0)}"`,
  ].join(" ");

  const header: string[] = [];
  header.push(el("ISIS_Ver", ctx.isisVer));
  header.push(el("BusinessDate_ID", ctx.businessDateId));
  header.push(el("Store_ID", ctx.storeId));
  header.push(el("Security_Token", ctx.securityToken));
  header.push(el("Check_No", ctx.checkNo));
  header.push(el("Employee_POS_ID", ctx.employeePosId));
  header.push(el("check_key", check.id)); // stable idempotency key for this check
  header.push(el("is_Mobile", "0"));
  header.push(el("RevenueCenter_POS_ID", check.revenueCenterId));
  header.push(el("Opened_On", dateTime(new Date(check.openedAt))));
  if (ctx.isToGo) header.push(el("order_type", "1"));
  header.push(el("active_At", stamp));

  return `${XML_HEAD}${DTD}<FinancialCheck ${checkAttrs}>${header.join("")}${tray}</FinancialCheck>`;
}

/* ---- Session lookups needed before a check can be sent ---- */

const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';

/** Parse "yyyy-MM-dd HH:mm:ss(.0)" (local) — the server's date format. */
function parseServerDate(s: string): Date {
  return new Date(String(s).trim().replace(" ", "T"));
}

/**
 * Resolve the current BusinessDate_ID (AITransactionManager getBussinessDateIDs
 * :2479-2500 + loadNewBusinessDateId :2336-2378). POSTs Trans_Type="BusinessDate",
 * then picks the row whose (BusinessDateEndsAt-24h, BusinessDateEndsAt] window
 * contains `now` — NOT simply the latest, since the feed carries future dates.
 * Returns "" if none resolves (caller must treat empty as not-ready).
 */
export async function resolveBusinessDate(cfg: SessionConfig, now = new Date()): Promise<string> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="BusinessDate">` +
    `<ISIS_Ver>${escapeXml(cfg.isisVer)}</ISIS_Ver><Store_ID>${escapeXml(cfg.storeId)}</Store_ID>` +
    `<Security_Token>${escapeXml(cfg.token)}</Security_Token></Transactional_Request>`;
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  const rows = asList(findKey(parsed, "Business_Date"));
  for (const r of rows) {
    const end = parseServerDate(textOf(findKey(r, "BusinessDateEndsAt")));
    if (Number.isNaN(end.getTime())) continue;
    const start = new Date(end.getTime() - 86_400_000);
    if (now > start && now <= end) return textOf(findKey(r, "Business_Date_ID"));
  }
  return "";
}

/** Highest existing check number for this business date/terminal (resetCheckCounter
 *  :5429-5488). Returns 0 when the store has no checks yet today. */
export async function fetchHighestCheck(cfg: SessionConfig, businessDateId: string): Promise<number> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="HighestCheck">` +
    `<ISIS_Ver>${escapeXml(cfg.isisVer)}</ISIS_Ver><Store_ID>${escapeXml(cfg.storeId)}</Store_ID>` +
    `<Security_Token>${escapeXml(cfg.token)}</Security_Token><BusinessDate_ID>${escapeXml(businessDateId)}</BusinessDate_ID>` +
    `<Terminal_POS_ID>${escapeXml(cfg.terminalPosId)}</Terminal_POS_ID></Transactional_Request>`;
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  return Number(textOf(findKey(parsed, "Check_Number"))) || 0;
}

/** Next check number (newCheckNumber :5508-5529): highest+1, or {terminalId}0001
 *  when the store has none yet today. */
export function nextCheckNo(highest: number, terminalPosId: string): string {
  return highest > 0 ? String(highest + 1) : `${terminalPosId}0001`;
}

export interface SendResult { ok: boolean; statusCode: string; message: string; }

/** Fire the check to the kitchen (or settle it with `settle:true`).
 *  Success = Message_Status Status_Code=="100". */
export async function sendCheck(enterpriseServerUrl: string, check: Check, ctx: SendContext, opts: { settle?: boolean } = {}): Promise<SendResult> {
  const xml = buildFinancialCheck(check, ctx, opts);
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(enterpriseServerUrl), xml));
    const code = textOf(findKey(parsed, "Status_Code"));
    const text = textOf(findKey(parsed, "Status_Text"));
    if (code === "100") return { ok: true, statusCode: code, message: text || "Sent" };
    return { ok: false, statusCode: code || "?", message: text || "Send failed" };
  } catch (e) {
    return { ok: false, statusCode: "COMMFAIL", message: `server unreachable: ${String((e as Error).message ?? e)}` };
  }
}
