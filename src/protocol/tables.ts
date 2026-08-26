/*
 * Table service — floorplan occupancy, check locking, and reading a check back.
 * All POST text/xml to /ISISPOS/HBroker (FinancialCheckManager.m):
 *   Open_Checks list        :13410  (Trans_Type="Open_Checks")
 *   read full check on tap  :7076   (Trans_Type="FinancialCheck")
 *   lock / unlock           :21500  (root <Set_Check_Lock Lock="1|0">)
 * Editing a resumed check re-POSTs the same <FinancialCheck> (protocol/order.ts).
 */

import { apiServerAddress, asList, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";
import { mintLineKey, type Check, type CheckLine, type TenderLine } from "@/model/check";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';
const LOCK_DTD = '<!DOCTYPE Set_Check_Lock SYSTEM "Transactions/Post_Messages/Set_Check_Lock.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

export interface OpenCheck {
  tableId: string;          // Table_POS_ID ("" for tabs/counter)
  checkNo: string;
  checkKey: string;
  businessDateId: string;
  empPosId: string;
  heldItem: boolean;
  printCount: number;
  isAllergy: boolean;
  lastModified: string;
}

/** List the store's open checks (floorplan occupancy). FinancialCheckManager.m:13410. */
export async function fetchOpenChecks(cfg: SessionConfig, businessDateId: string, opts: { empPosId?: string } = {}): Promise<OpenCheck[]> {
  const emp = opts.empPosId ? el("Emp_POS_ID", opts.empPosId) : "";
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Open_Checks">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", businessDateId) + emp + `</Transactional_Request>`;
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  return asList(findKey(parsed, "Open_Check")).map((r: XmlDict) => ({
    tableId: textOf(findKey(r, "Table_POS_ID")),
    checkNo: textOf(findKey(r, "Check_Number")),
    checkKey: textOf(findKey(r, "check_key")),
    businessDateId: textOf(findKey(r, "BusinessDate_ID")) || businessDateId,
    empPosId: textOf(findKey(r, "Emp_POS_ID")),
    heldItem: textOf(findKey(r, "Held_Item")) === "1",
    printCount: Number(textOf(findKey(r, "Print_Count"))) || 0,
    isAllergy: textOf(findKey(r, "Is_Allergy")) === "1",
    lastModified: textOf(findKey(r, "Last_Modified_Time")) || textOf(findKey(r, "last_Modified_Time")),
  }));
}

export interface LockResult { ok: boolean; code: string; message: string; alreadyLocked: boolean; }

async function setLock(cfg: SessionConfig, p: { checkNo: string; checkKey: string; businessDateId: string }, lock: boolean): Promise<LockResult> {
  const xml = `${XML_HEAD}${LOCK_DTD}<Set_Check_Lock Lock="${lock ? "1" : "0"}">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Terminal_POS_ID", cfg.terminalPosId) + el("Check_No", p.checkNo) + el("check_key", p.checkKey) +
    el("BusinessDate_ID", p.businessDateId) + `</Set_Check_Lock>`;
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", code, alreadyLocked: code === "200", message: textOf(findKey(parsed, "Status_Text")) || code };
  } catch (e) { return { ok: false, code: "COMMFAIL", alreadyLocked: false, message: String((e as Error).message ?? e) }; }
}
export const lockCheck = (cfg: SessionConfig, p: { checkNo: string; checkKey: string; businessDateId: string }) => setLock(cfg, p, true);
export const unlockCheck = (cfg: SessionConfig, p: { checkNo: string; checkKey: string; businessDateId: string }) => setLock(cfg, p, false);

export interface CheckNames { menuItemName: (id: string) => string; tenderName: (id: string) => string; }

/**
 * Read a full check back and reconstruct our Check model (parsePullBackCheck,
 * FinancialCheckManager.m:5875). Returns null if the server has no such check.
 * The check_key is preserved so a subsequent send/settle updates the same check.
 */
export async function readCheck(
  cfg: SessionConfig, p: { checkNo: string; checkKey: string; businessDateId: string }, names: CheckNames,
): Promise<Check | null> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="FinancialCheck">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("BusinessDate_ID", p.businessDateId) +
    el("Check_No", p.checkNo) + el("check_key", p.checkKey) + el("Security_Token", cfg.token) + `</Transactional_Request>`;
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  const fc = findKey(parsed, "FinancialCheck");
  if (!fc || typeof fc === "string") return null;
  const check = Array.isArray(fc) ? (fc[0] as XmlDict) : (fc as XmlDict);
  if (!check || typeof check === "string") return null;

  const lines: CheckLine[] = [];
  const tenders: TenderLine[] = [];
  const keyByTrayLine = new Map<string, string>(); // "tray:line" → local key
  const trays = asList(findKey(check, "Tray"));
  let trayCount = 0;
  for (const tray of trays) {
    trayCount++;
    const trayNum = textOf(tray["Tray_Number"]) || String(trayCount);
    for (const li of asList(findKey(tray, "LineItem"))) {
      if (textOf(li["Is_Void"]) === "1" || textOf(li["Transfered_Out"]) === "1") continue;
      const type = textOf(li["Type"]) || "M";
      const qty = Number(textOf(findKey(li, "Quantity"))) || 1;
      const ext = Number(textOf(findKey(li, "Line_Amount"))) || 0;
      const lineNo = textOf(findKey(li, "Line_Number"));
      if (type === "T") {
        const tid = textOf(findKey(li, "Tender_POS_ID"));
        tenders.push({
          key: mintLineKey(), tenderId: tid, name: names.tenderName(tid),
          amount: ext, tip: Number(textOf(findKey(li, "Tip_Amount"))) || 0,
          change: Number(textOf(findKey(li, "Change_Given"))) || 0,
          reference: textOf(findKey(li, "Reference")) || undefined,
          balanceRef: textOf(findKey(li, "Transaction_Ref")) || undefined, sent: true,
        });
        continue;
      }
      const mid = textOf(findKey(li, "MenuItem_POS_ID"));
      const parentLine = textOf(findKey(li, "Parent_LineItem_ID"));
      const parentTray = textOf(findKey(li, "Parent_Tray_Number")) || trayNum;
      const key = mintLineKey();
      keyByTrayLine.set(`${trayNum}:${lineNo}`, key);
      lines.push({
        key, menuItemId: mid, description: names.menuItemName(mid),
        quantity: qty, amount: qty ? Math.round((ext / qty) * 100) / 100 : ext,
        kind: parentLine ? "Mo" : "M", indentLevel: parentLine ? 1 : 0,
        parentKey: parentLine ? keyByTrayLine.get(`${parentTray}:${parentLine}`) : undefined,
        guestNumber: Number(textOf(findKey(li, "Guest_Num"))) || undefined, sent: true,
      });
    }
  }

  return {
    id: textOf(findKey(check, "check_key")) || p.checkKey,
    checkNumber: textOf(findKey(check, "Check_No")) || p.checkNo,
    revenueCenterId: textOf(findKey(check, "RevenueCenter_POS_ID")),
    diningTableId: textOf(findKey(check, "DiningTable_POS_ID")) || undefined,
    tableName: textOf(check["Check_Name"]),
    guestCount: Number(textOf(check["Guest_Count"])) || 1,
    lines, tenders, traysSent: trayCount, openedAt: Date.now(),
  };
}
