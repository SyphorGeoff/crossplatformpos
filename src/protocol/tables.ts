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
import { mintLineKey, TIMED_ACTIVE, type Check, type CheckLine, type TenderLine } from "@/model/check";

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

export interface CheckNames {
  menuItemName: (id: string) => string; tenderName: (id: string) => string; adjustmentName?: (id: string) => string;
  /** ToppingPrefix POS_ID → its InventoryMultiplier (the wire Quantity is count × this); undefined when unknown. */
  prefixQtyMult?: (id: string) => number | undefined;
  /** ToppingPrefix POS_ID → its name, when the line came back without a pfix. */
  prefixName?: (id: string) => string | undefined;
}

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

  const { lines, tenders } = parseCheckLines(check, names);
  const exemptTaxGroups = parseExemptTaxGroups(check);

  return {
    ...(exemptTaxGroups.length ? { exemptTaxGroups } : {}),
    id: textOf(findKey(check, "check_key")) || p.checkKey,
    checkNumber: textOf(findKey(check, "Check_No")) || p.checkNo,
    revenueCenterId: textOf(findKey(check, "RevenueCenter_POS_ID")),
    diningTableId: textOf(findKey(check, "DiningTable_POS_ID")) || undefined,
    tableName: textOf(check["Check_Name"]),
    employeePosId: textOf(findKey(check, "Employee_POS_ID")) || undefined,
    guestCount: Number(textOf(check["Guest_Count"])) || 1,
    lines, tenders, traysSent: asList(findKey(check, "Tray")).length, openedAt: Date.now(),
  };
}

/** Tax exemptions ride the FinancialCheck as <Tax_Group_Amt><Tax_Report_Group_POS_ID Is_Exempt="1">
 *  (parsePullBackCheck :14913-14923 → TaxManager removeTaxWithGroupPOS). */
export function parseExemptTaxGroups(check: XmlDict): string[] {
  return asList(findKey(check, "Tax_Group_Amt")).flatMap((g) => {
    const trg = g["Tax_Report_Group_POS_ID"];
    if (!trg || typeof trg === "string" || Array.isArray(trg)) return [];
    const id = typeof trg._text === "string" ? trg._text.trim() : ""; // attribute + text element → {Is_Exempt, _text}
    return trg["Is_Exempt"] === "1" && id ? [id] : [];
  }).filter(Boolean);
}

/* ---- Pull-back line parsing (FinancialCheckManager loadCurrentFinancialCheck +
 * isValid: :16746-16850). The server keeps every line ever posted; the CLIENT nets:
 *   - a line that is itself Is_Void / Transfered_Out / Is_Split is a marker, not an item;
 *   - an original named by a void reversal's Void_Parent_Tray_Number/Void_Line_Item_ID
 *     is struck (shown voided, no value);
 *   - an original named by a Transfered_Out / Is_Split line's Parent_* has LEFT the
 *     check and is dropped.
 * Type "T" → tender, "A" → adjustment, "R" → reference (hidden/shown per refIsShown),
 * anything else → menu item (modifier when it has a Parent_LineItem_ID). Is_Held and
 * applied_to_guests are restored. */
export function parseCheckLines(check: XmlDict, names: CheckNames): { lines: CheckLine[]; tenders: TenderLine[] } {
  interface Raw {
    tray: string; line: string; type: string; isVoid: boolean; xfer: boolean; split: boolean; held: boolean;
    parentTray: string; parentLine: string; voidTray: string; voidLine: string;
    qty: number; ext: number; guest?: number; applied?: string; auth?: string; ref: string;
    mid: string; adj: string; tid: string; tip: number; change: number; reference?: string; balanceRef?: string;
    course?: number;
    sentAt?: number;
    prefixId: string; pfix: string;
  }
  const raws: Raw[] = [];
  let trayCount = 0;
  for (const tray of asList(findKey(check, "Tray"))) {
    trayCount++;
    const trayNum = textOf(tray["Tray_Number"]) || String(trayCount);
    const sentOn = Date.parse(textOf(tray["Sent_On"]).replace(" ", "T"));   // "yyyy-MM-dd HH:mm:ss" (server clock) — the timed-item start
    for (const li of asList(findKey(tray, "LineItem"))) {
      const t = (k: string) => textOf(findKey(li, k));
      raws.push({
        tray: trayNum, line: t("Line_Number"), type: textOf(li["Type"]) || "M", sentAt: Number.isNaN(sentOn) ? undefined : sentOn,
        isVoid: textOf(li["Is_Void"]) === "1", xfer: textOf(li["Transfered_Out"]) === "1", split: textOf(li["Is_Split"]) === "1",
        held: textOf(li["Is_Held"]) === "1",
        parentTray: t("Parent_Tray_Number"), parentLine: t("Parent_LineItem_ID"),
        voidTray: t("Void_Parent_Tray_Number"), voidLine: t("Void_Line_Item_ID"),
        qty: Number(t("Quantity")) || 1, ext: Number(t("Line_Amount")) || 0,
        guest: Number(t("Guest_Num")) >= 0 && t("Guest_Num") !== "" ? Number(t("Guest_Num")) : undefined,
        applied: t("applied_to_guests") || undefined, auth: t("AuthorizingEmployee_ID") || undefined, ref: t("Reference"),
        mid: t("MenuItem_POS_ID"), adj: t("Adjustment_POS_ID"), tid: t("Tender_POS_ID"),
        tip: Number(t("Tip_Amount")) || 0, change: Number(t("Change_Given")) || 0,
        reference: t("Reference") || undefined, balanceRef: t("Transaction_Ref") || undefined,
        course: t("print_Sort_Order") !== "" && Number.isFinite(Number(t("print_Sort_Order"))) ? Number(t("print_Sort_Order")) : undefined,
        prefixId: t("toppingPrefix_ID"), pfix: t("pfix"),
      });
    }
  }
  const voided = new Set<string>();   // originals cancelled by a void reversal
  const removed = new Set<string>();  // originals that left (transfer / split)
  for (const r of raws) {
    if (r.isVoid && r.voidLine) voided.add(`${r.voidTray || r.tray}:${r.voidLine}`);
    // Repair for reversals posted before 1.24 without their Void_* link (the -0 bug): a $0
    // "Timed Item Active" reversal strikes the earliest still-live $0 running line of that item.
    if (r.isVoid && !r.voidLine && r.ext === 0 && r.ref === TIMED_ACTIVE && r.type !== "T" && r.type !== "A" && r.type !== "R") {
      const target = raws.find((o) => o !== r && !o.isVoid && !o.xfer && !o.split && o.mid === r.mid && o.ext === 0 && o.ref === TIMED_ACTIVE && !voided.has(`${o.tray}:${o.line}`));
      if (target) voided.add(`${target.tray}:${target.line}`);
    }
    if ((r.xfer || r.split) && r.parentLine) removed.add(`${r.parentTray || r.tray}:${r.parentLine}`);
  }
  const lines: CheckLine[] = [];
  const tenders: TenderLine[] = [];
  const keyByTrayLine = new Map<string, string>();
  for (const r of raws) {
    if (r.isVoid || r.xfer || r.split) continue;             // markers, not items
    const id = `${r.tray}:${r.line}`;
    if (removed.has(id)) continue;                           // moved to another check
    const struck = voided.has(id);
    const common = { trayNumber: Number(r.tray) || undefined, lineNumber: Number(r.line) || undefined, sent: true as const, sentAt: r.sentAt };
    if (r.type === "T") {
      if (struck) continue;
      tenders.push({ key: mintLineKey(), tenderId: r.tid, name: names.tenderName(r.tid), amount: r.ext, tip: r.tip, change: r.change, reference: r.reference, balanceRef: r.balanceRef, ...common });
      continue;
    }
    const key = mintLineKey();
    keyByTrayLine.set(id, key);
    if (r.type === "A") {
      // an item-level adjustment carries Parent_* → sits under its item (indented) so
      // later discounts see the item's net and "once per item" can be enforced
      const parentKey = r.parentLine ? keyByTrayLine.get(`${r.parentTray || r.tray}:${r.parentLine}`) : undefined;
      lines.push({ key, menuItemId: "", description: names.adjustmentName?.(r.adj) ?? `#${r.adj}`, quantity: 1, amount: r.ext, kind: "A", indentLevel: parentKey ? 1 : 0,
        adjustmentId: r.adj, authEmpId: r.auth, guestNumber: r.guest, appliedToGuests: r.applied, isVoid: struck || undefined, parentKey, ...common });
      continue;
    }
    if (r.type === "R") {
      lines.push({ key, menuItemId: "", description: "", quantity: 1, amount: 0, kind: "R", indentLevel: 0,
        reference: r.ref, authEmpId: r.auth, guestNumber: r.guest, appliedToGuests: r.applied, isVoid: struck || undefined, ...common });
      continue;
    }
    const isMod = !!r.parentLine;
    const parentKey = isMod ? keyByTrayLine.get(`${r.parentTray || r.tray}:${r.parentLine}`) : undefined;
    const parentLine = parentKey ? lines.find((x) => x.key === parentKey) : undefined;
    // A prefixed line's Quantity is count × InventoryMultiplier — divide it back out for display
    // (CheckTableCellView :397-425), and price the unit from the count.
    // A modifier's factor is its own × its parent's (already combined up the chain).
    const own = r.prefixId ? names.prefixQtyMult?.(r.prefixId) ?? 1 : 1;
    const mult = own * (parentLine?.prefixQtyMult ?? 1);
    const count = mult > 0 && mult !== 1 ? Math.round((r.qty / mult) * 1000) / 1000 : r.qty;
    lines.push({
      key, menuItemId: r.mid, description: names.menuItemName(r.mid),
      quantity: count, amount: count ? Math.round((r.ext / count) * 100) / 100 : r.ext,
      ...(r.prefixId ? { prefixId: r.prefixId, pfix: r.pfix || names.prefixName?.(r.prefixId) || "" } : {}),
      ...(r.prefixId || mult !== 1 ? { prefixQtyMult: mult } : {}),
      kind: isMod ? "Mo" : "M", indentLevel: isMod ? (parentLine ? parentLine.indentLevel + 1 : 1) : 0,   // a modifier of a modifier nests one deeper
      parentKey,
      guestNumber: r.guest, appliedToGuests: r.applied, held: r.held || undefined, isVoid: struck || undefined,
      course: isMod ? undefined : r.course, reference: !isMod && r.ref ? r.ref : undefined, ...common,
    });
  }
  return { lines, tenders };
}

/* ---- Live single-field edit of a posted line (postLineItemModifyforstore_id
 * :11645-11700): Trans_Type="Modify", Record_Type LineItem. The iPad uses it for
 * Guest_Num (change guest on a sent line) and Line_Amount. Success = Status_Code 100. */
export async function modifyLineItem(cfg: SessionConfig, p: {
  businessDateId: string; checkNo: string; checkKey: string; trayNumber: number; lineNumber: number; field: "Guest_Num" | "Line_Amount" | "print_Sort_Order"; value: string;
}): Promise<{ ok: boolean; message: string }> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Modify"><ISIS_Ver>1.0</ISIS_Ver>` +
    `<Store_ID>${escapeXml(cfg.storeId)}</Store_ID><Security_Token>${escapeXml(cfg.token)}</Security_Token><Record_Type>LineItem</Record_Type>` +
    `<BusinessDate_ID>${escapeXml(p.businessDateId)}</BusinessDate_ID><Check_No>${escapeXml(p.checkNo)}</Check_No><check_key>${escapeXml(p.checkKey)}</check_key>` +
    `<Tray_Number>${p.trayNumber}</Tray_Number><Line_Number>${p.lineNumber}</Line_Number>` +
    `<Field_Name>${p.field}</Field_Name><Field_Value>${escapeXml(p.value)}</Field_Value></Transactional_Request>`;
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
    const code = textOf(findKey(parsed, "Status_Code"));
    return { ok: code === "100", message: textOf(findKey(parsed, "Status_Text")) || code || "No response" };
  } catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** The employee's tenders still awaiting finalization (tip/capture) — CreditCardManager
 *  loadUnFinalizedTenders: Trans_Type="Unfinalized_Tenders" for this business date /
 *  employee / terminal. Clock-out is refused while any exist (pressClockOut). */
export async function fetchUnfinalizedTenders(cfg: SessionConfig, p: { businessDateId: string; empPosId: string }): Promise<{ empPosId: string; checkNo: string }[]> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Unfinalized_Tenders">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", p.businessDateId) + el("Emp_POS_ID", p.empPosId) + el("Terminal_POS_ID", cfg.terminalPosId) +
    `</Transactional_Request>`;
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  return asList(findKey(parsed, "Unfinalized_Tender")).map((r) => ({
    empPosId: textOf(findKey(r, "Emp_POS_ID")), checkNo: textOf(findKey(r, "Check_Number")) || textOf(findKey(r, "Check_No")),
  })).filter((t) => !p.empPosId || t.empPosId === p.empPosId);
}
