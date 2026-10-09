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
import { generateCheckKey, unsentLines, unsentTenders, type Check, type CheckLine, type TenderLine } from "@/model/check";

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

/** traykey — a 7-digit NUMERIC key, exactly as the iOS app mints check/tray/line
 *  keys (FinancialCheckManager.generateCheckKey). The server requires numeric keys. */
export const mintCheckKey = generateCheckKey;

export interface SendContext {
  isisVer: string;
  storeId: string;
  securityToken: string;
  terminalPosId: string;
  employeePosId: string;
  checkEmployeePosId?: string; // the check's OWNER when it differs from the sender (Transfer Check → employee)
  businessDateId: string;   // required header field (see resolveBusinessDate)
  checkNo: string;          // client-assigned check number
  isToGo?: boolean;
}

const el = (name: string, value: string | number): string => `<${name}>${escapeXml(String(value))}</${name}>`;

/** One <LineItem …>. `lineNumber` map lets modifiers point at their parent.
 *  Emits Type="M" (menu/modifier), "A" for adjustments, or "R" for reference
 *  lines (non-priced notes/records — Print_On_Check/Show_On_Display 0). */
function xmlLineItem(line: CheckLine, lineNumber: number, trayNumber: number, parentLineNumber?: number, parent?: CheckLine): string {
  const type = line.kind === "A" ? "A" : line.kind === "R" ? "R" : "M";
  const isRef = type === "R";
  // A Transfered_Out void-off is invisible everywhere (voidLineItems isTransferItems :1946-1952).
  const hidden = isRef || !!line.transferOut;
  const attrs = [
    `Is_Held="${line.held ? "1" : "0"}"`,
    `Is_Void="${line.isVoid ? "1" : "0"}"`,
    `Transfered_Out="${line.transferOut ? "1" : "0"}"`,
    `Print_On_Check="${hidden ? "0" : "1"}"`,
    `Show_On_Display="${hidden ? "0" : "1"}"`,
    `Type="${type}"`,
    `Finalized="0"`,
    `Is_Split="${line.isSplit ? "1" : "0"}"`,
    `lineitemkey="${escapeXml(line.key)}"`,
    `posted="0"`,
  ].join(" ");
  const parts: string[] = [];
  // Guest_Num: emitted when set; M/A lines default to guest 1 (0 is a valid
  // whole-table value and is emitted as-is). Reference lines omit it when unset.
  if (line.guestNumber !== undefined) parts.push(el("Guest_Num", line.guestNumber));
  else if (!isRef) parts.push(el("Guest_Num", 1));
  if (line.appliedToGuests !== undefined) parts.push(el("applied_to_guests", line.appliedToGuests));
  if ((line.transferOut || line.isSplit) && line.parentLineNumber !== undefined) {
    // points at the ORIGINAL line that left this check (or was divided among guests)
    parts.push(el("Parent_LineItem_ID", line.parentLineNumber));
    parts.push(el("Parent_Tray_Number", line.parentTrayNumber ?? trayNumber));
  } else if (line.isVoid && line.amount < 0 && line.parentLineNumber !== undefined) {
    // a void reversal names the ORIGINAL it cancels (voidLineItems :1957-1958) —
    // without these the server (and every pull-back) keeps the original live
    parts.push(el("Void_Line_Item_ID", line.parentLineNumber));
    parts.push(el("Void_Parent_Tray_Number", line.parentTrayNumber ?? trayNumber));
  } else if (line.kind === "A" && parent?.sent && parent.lineNumber !== undefined) {
    // an item-level discount on an already-sent item points at the item's stamped
    // tray/line (addAdjustmentsToLineItems: Parent_LineItem_ID/Parent_Tray_Number)
    parts.push(el("Parent_LineItem_ID", parent.lineNumber));
    parts.push(el("Parent_Tray_Number", parent.trayNumber ?? trayNumber));
  } else if ((line.kind === "Mo" || line.kind === "A") && parentLineNumber !== undefined) {
    parts.push(el("Parent_LineItem_ID", parentLineNumber));
    parts.push(el("Parent_Tray_Number", trayNumber));
  }
  if (line.authEmpId) parts.push(el("AuthorizingEmployee_ID", line.authEmpId));
  parts.push(el("Quantity", line.quantity));
  parts.push(el("Line_Number", lineNumber));
  // Course (print_Sort_Order, FinancialCheckManager :12359): an item's own override;
  // a modifier rides its parent's so a pull-back on another terminal agrees.
  const course = line.kind === "M" ? line.course : line.kind === "Mo" ? parent?.course : undefined;
  if (course !== undefined) parts.push(el("print_Sort_Order", course));
  if (type === "A") parts.push(el("Adjustment_POS_ID", line.adjustmentId ?? ""));
  else if (!isRef) parts.push(el("MenuItem_POS_ID", line.menuItemId));
  if (line.voidPosId) parts.push(el("Void_POS_ID", line.voidPosId));
  if (line.reference && (isRef || line.kind === "M")) parts.push(el("Reference", line.reference)); // iOS: any line with a Reference emits it (:12363)
  parts.push(el("Line_Amount", (isRef ? 0 : line.amount * line.quantity).toFixed(2))); // extended, like the iPad's Amount
  return `<LineItem ${attrs}>${parts.join("")}</LineItem>`;
}

/** One <LineItem Type="T"> — a tender/payment (FinancialCheckManager.m:7224/12255). */
function xmlTenderLine(t: TenderLine, lineNumber: number, trayNumber: number): string {
  const attrs = [
    `Is_Held="0"`, `Is_Void="${t.isVoid ? "1" : "0"}"`, `Transfered_Out="0"`, `Print_On_Check="1"`,
    `Show_On_Display="0"`, `Type="T"`, `Finalized="1"`, `Is_Split="0"`,
    `lineitemkey="${escapeXml(t.key)}"`, `posted="0"`,
  ].join(" ");
  const parts: string[] = [];
  if (t.isVoid && t.parentLineNumber !== undefined) {
    // a tender reversal names the ORIGINAL payment it cancels (voidLineItem on a Type T line)
    parts.push(el("Void_Line_Item_ID", t.parentLineNumber));
    parts.push(el("Void_Parent_Tray_Number", t.parentTrayNumber ?? trayNumber));
  }
  if (t.authEmpId) parts.push(el("AuthorizingEmployee_ID", t.authEmpId));
  parts.push(el("Quantity", 1));
  parts.push(el("Line_Number", lineNumber));
  parts.push(el("Tender_POS_ID", t.tenderId));
  if (t.voidPosId) parts.push(el("Void_POS_ID", t.voidPosId));
  if (t.tip) parts.push(el("Tip_Amount", t.tip.toFixed(2)));
  if (t.change) parts.push(el("Change_Given", t.change.toFixed(2)));
  if (t.balanceRef) parts.push(el("Transaction_Ref", t.balanceRef));
  if (t.reference) parts.push(el("Reference", t.reference));
  parts.push(el("Line_Amount", t.amount.toFixed(2)));
  return `<LineItem ${attrs}>${parts.join("")}</LineItem>`;
}

/** Per-report-group tax breakdown for the FinancialCheck (<Tax_Group_Amt>). */
export interface WireTaxGroup { reportGroupId: string; amount: string; isExempt: boolean; }

export interface SendOpts {
  settle?: boolean;        // Is_Closed + Is_Settled (tendered out)
  cancel?: boolean;        // Is_Cancelled + Is_Closed
  close?: boolean;         // Is_Closed only — a source emptied by a split/transfer
  transferred?: boolean;   // Is_Transferred=1 — a merge source
  taxGroups?: WireTaxGroup[];
}

/** The full FinancialCheck document for the check's unsent round (one tray).
 *  `settle` closes the check: adds the tender lines' round and flips Is_Closed /
 *  Is_Settled (settle is the same POST re-sent, not a separate message —
 *  FinancialCheckManager.m:13824/23664/7953). `taxGroups` emit the tax
 *  breakdown (FinancialCheckManager.m:8274-8298). */
export function buildFinancialCheck(check: Check, ctx: SendContext, opts: SendOpts = {}, now = new Date()): string {
  const settle = opts.settle ?? false;
  const cancel = opts.cancel ?? false;
  const close = opts.close ?? false;
  const trayNumber = check.traysSent + 1;
  const stamp = dateTime(now);

  // Line_Number is tray-scoped: items first (so modifiers can reference their
  // parent's number within the tray), then tender lines.
  const items = unsentLines(check);
  const numberByKey = new Map<string, number>();
  items.forEach((l, i) => numberByKey.set(l.key, i + 1));
  const tenders = unsentTenders(check);

  const itemXml = items
    .map((l) => xmlLineItem(l, numberByKey.get(l.key)!, trayNumber, l.parentKey ? numberByKey.get(l.parentKey) : undefined,
      l.parentKey ? check.lines.find((x) => x.key === l.parentKey) : undefined))
    .join("");
  const tenderXml = tenders.map((t, i) => xmlTenderLine(t, items.length + i + 1, trayNumber)).join("");

  const tray =
    `<Tray Tray_Number="${trayNumber}" Terminal_POS_ID="${escapeXml(ctx.terminalPosId)}" ` +
    `Sent_On="${stamp}" Employee_POS_ID="${escapeXml(ctx.employeePosId)}" traykey="${mintCheckKey()}">` +
    itemXml + tenderXml + `</Tray>`;

  const flag = (b: boolean) => (b ? "1" : "0");
  const checkAttrs = [
    `Is_Cancelled="${flag(cancel)}"`, `Is_Return="0"`, `Print_Count="0"`, `Is_Transferred="${flag(opts.transferred ?? false)}"`,
    `is_FutureOrder="0"`, `Is_Split="0"`, `Is_Tax_Exempt="0"`,
    `Guest_Count="${check.guestCount}"`, `Is_Closed="${flag(settle || cancel || close)}"`, `Is_Reopen="0"`,
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
  header.push(el("Employee_POS_ID", ctx.checkEmployeePosId ?? check.employeePosId ?? ctx.employeePosId)); // the check's owner, not necessarily the sender
  header.push(el("check_key", check.id)); // stable idempotency key for this check
  header.push(el("is_Mobile", "0"));
  if (check.diningTableId) header.push(el("DiningTable_POS_ID", check.diningTableId));
  header.push(el("RevenueCenter_POS_ID", check.revenueCenterId));
  header.push(el("Opened_On", dateTime(new Date(check.openedAt))));
  if (ctx.isToGo) header.push(el("order_type", "1"));
  header.push(el("active_At", stamp));

  // Tax breakdown, one <Tax_Group_Amt> per report group (after the header,
  // before the trays).
  const taxXml = (opts.taxGroups ?? [])
    .map((g) => `<Tax_Group_Amt><Tax_Report_Group_POS_ID Is_Exempt="${g.isExempt ? "1" : "0"}">${escapeXml(g.reportGroupId)}</Tax_Report_Group_POS_ID><Tax_Amount>${escapeXml(g.amount)}</Tax_Amount></Tax_Group_Amt>`)
    .join("");

  return `${XML_HEAD}${DTD}<FinancialCheck ${checkAttrs}>${header.join("")}${taxXml}${tray}</FinancialCheck>`;
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
export async function sendCheck(enterpriseServerUrl: string, check: Check, ctx: SendContext, opts: SendOpts = {}): Promise<SendResult> {
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
