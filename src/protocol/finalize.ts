/*
 * Finalize — the two HBroker messages behind the "finalize credit tenders"
 * screen (CreditCardManager.m loadUnFinalizedTenders :509 / finalizeTender :399):
 *   Transactional_Request Trans_Type="Unfinalized_Tenders" — every Type="T" line
 *     with Finalized="0" on a SETTLED check of this business date (server
 *     Check.getUnfinalizedXML requires is_Settled), with its card fields;
 *   Finalize_Tender (root <Post_Message>) — sets Tip_Amount, flips Finalized,
 *     and, when RefNo comes in the 5-part ":ZZ:" form, updates the stored
 *     RefNo / RecordNo / AuthCode (Check.finalizeTender). We always send that
 *     form so a capture that returns a new processor id is recorded whatever
 *     Store.hostbased_cc says.
 */

import { apiServerAddress, asList, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';
const FIN_DTD = '<!DOCTYPE Finalize_Tender SYSTEM "Transactions/Post_Messages/Finalize_Tender.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

/** One authorized-but-not-captured card tender, as the server lists it. */
export interface UnfinalizedTender {
  checkNo: string;          // Check_Number
  checkKey: string;         // check_key
  checkName: string;        // Check_Name (table / tab label)
  tableId: string;          // Table_POS_ID
  businessDateId: string;
  empPosId: string;         // the check's owner
  revenueCenterId: string;
  trayNumber: number;       // Tray_Number
  lineNumber: number;       // Line_Item_Ref_ID (the line's Line_Number within the tray)
  tenderId: string;         // Tender_POS_ID
  baseAmount: number;       // Base_Amount — the authorized amount
  refNo: string;            // RefNo (processor transaction id)
  recordNo: string;
  authCode: string;
  last4: string;            // from TruncatedAcctNo / AcctNo
}

export function parseUnfinalized(parsed: XmlDict): UnfinalizedTender[] {
  return asList(findKey(parsed, "Unfinalized_Tender")).map((r) => {
    const t = (k: string) => textOf(findKey(r, k));
    const acct = t("TruncatedAcctNo") || t("AcctNo");
    return {
      checkNo: t("Check_Number"), checkKey: t("check_key"), checkName: t("Check_Name"), tableId: t("Table_POS_ID"),
      businessDateId: t("BusinessDate_ID"), empPosId: t("Emp_POS_ID"), revenueCenterId: t("RevenueCenter_POS_ID"),
      trayNumber: Number(t("Tray_Number")) || 0, lineNumber: Number(t("Line_Item_Ref_ID")) || 0,
      tenderId: t("Tender_POS_ID"), baseAmount: Number(t("Base_Amount")) || 0,
      refNo: t("RefNo"), recordNo: t("RecordNo"), authCode: t("AuthCode"),
      last4: acct.replace(/[^0-9]/g, "").slice(-4),
    };
  }).filter((u) => u.checkNo);
}

/** The business date's unfinalized card tenders (all employees; the caller
 *  filters to its own unless it holds FINALIZE_CREDIT / is a manager). */
export async function fetchUnfinalized(cfg: SessionConfig, businessDateId: string): Promise<UnfinalizedTender[]> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Unfinalized_Tenders">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", businessDateId) + el("Terminal_POS_ID", cfg.terminalPosId) + `</Transactional_Request>`;
  return parseUnfinalized(parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml)));
}

export interface FinalizeParams {
  tip: number;
  lineNumber: number;       // Line_Item_Ref_ID
  trayNumber: number;
  checkNo: string;
  checkKey: string;
  businessDateId: string;
  ref?: string;             // processor id after capture (RefNo); omitted = keep what the server has
  recordNo?: string;
  authCode?: string;
  authEmpId?: string;       // Authorizing_Emp_POS_ID when a manager finalized someone else's tender
}

/** RefNo in the server's 5-part form: ref :ZZ: recordNo :ZZ: authCode :ZZ: acqRefData :ZZ: processData
 *  ("A" = leave that field alone). Check.finalizeTender only updates fields from this form. */
export function refNoField(p: { ref?: string; recordNo?: string; authCode?: string }): string {
  const part = (v?: string) => (v && v.trim() ? v.trim() : "A");
  return `${part(p.ref)}:ZZ:${part(p.recordNo ?? p.ref)}:ZZ:${part(p.authCode)}:ZZ:A:ZZ:A`;
}

export function buildFinalizeTender(cfg: SessionConfig, p: FinalizeParams): string {
  return `${XML_HEAD}${FIN_DTD}<Post_Message>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Tip_Amount", p.tip.toFixed(2)) + el("Line_Item_Ref_ID", p.lineNumber) + el("Check_Number", p.checkNo) +
    el("check_key", p.checkKey) + el("Tray_Number", p.trayNumber) + el("BusinessDate_ID", p.businessDateId) +
    (p.authEmpId ? el("Authorizing_Emp_POS_ID", p.authEmpId) : "") +
    (p.ref ? el("RefNo", refNoField(p)) : "") +
    `</Post_Message>`;
}

/** Post the finalize. Success = Status_Code 100. */
export async function postFinalizeTender(cfg: SessionConfig, p: FinalizeParams): Promise<{ ok: boolean; message: string }> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), buildFinalizeTender(cfg, p)));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}
