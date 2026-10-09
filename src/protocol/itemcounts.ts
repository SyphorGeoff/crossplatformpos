/*
 * 86 / item countdown wire (MenuItemCountManager.m):
 *  - read:   Transactional_Request Trans_Type="Menu_Item_Counters" (:352) →
 *            <Menu_Item_Counters><Menu_Item_Counter><Menu_Item_POS_ID/><Counter/>…
 *  - set:    <Update_Menu_Item_Counter Remove_Counter="0" …><Counter>n</Counter> (:653)
 *  - remove: <Update_Menu_Item_Counter Remove_Counter="1" …> (:704)
 * All POST text/xml to /ISISPOS/HBroker; success = Message_Status Status_Code 100.
 */

import { apiServerAddress, asList, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';
const UPDATE_DTD = '<!DOCTYPE Update_Menu_Item_Counter SYSTEM "Transactions/Post_Messages/Update_Menu_Item_Counter.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

export interface CounterRow { menuItemId: string; counter: number; }

export function menuItemCountersXml(cfg: SessionConfig, p: { businessDateId: string; empPosId: string }): string {
  return `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Menu_Item_Counters">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", p.businessDateId) + el("Emp_POS_ID", p.empPosId) + el("Terminal_POS_ID", cfg.terminalPosId) +
    `</Transactional_Request>`;
}

/** Set (`counter` given, 0 = sold out) or remove (`remove`) an item's counter. */
export function updateMenuItemCounterXml(cfg: SessionConfig, p: { menuItemId: string; counter?: number; remove?: boolean; authEmpId: string }): string {
  const remove = p.remove ? "1" : "0";
  return `${XML_HEAD}${UPDATE_DTD}<Update_Menu_Item_Counter Remove_Counter="${remove}" Decrement_Counter="0" Increment_Counter="0">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("Menu_Item_POS_ID", p.menuItemId) +
    (p.remove ? "" : el("Counter", Math.max(0, Math.floor(p.counter ?? 0)))) +
    el("Authorizing_Emp_POS_ID", p.authEmpId) +
    `</Update_Menu_Item_Counter>`;
}

export function parseMenuItemCounters(parsed: XmlDict): CounterRow[] {
  const rows: CounterRow[] = [];
  for (const r of asList(findKey(parsed, "Menu_Item_Counter"))) {
    const menuItemId = textOf(findKey(r, "Menu_Item_POS_ID")).trim();
    const counter = Number(textOf(findKey(r, "Counter")).trim());
    if (menuItemId && Number.isFinite(counter)) rows.push({ menuItemId, counter });
  }
  return rows;
}

/** The store's counters for the business date; null when the server is unreachable. */
export async function fetchMenuItemCounters(cfg: SessionConfig, p: { businessDateId: string; empPosId: string }): Promise<CounterRow[] | null> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), menuItemCountersXml(cfg, p)));
    return parseMenuItemCounters(parsed);
  } catch { return null; }
}

async function postUpdate(cfg: SessionConfig, xml: string): Promise<{ ok: boolean; message: string }> {
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
    const code = textOf(findKey(parsed, "Status_Code")).trim();
    const text = textOf(findKey(parsed, "Status_Text")).trim();
    return { ok: code === "100", message: text || (code === "100" ? "OK" : `Status ${code || "unknown"}`) };
  } catch (e) { return { ok: false, message: String((e as Error).message ?? e) }; }
}

export const setMenuItemCounter = (cfg: SessionConfig, p: { menuItemId: string; counter: number; authEmpId: string }) =>
  postUpdate(cfg, updateMenuItemCounterXml(cfg, p));
export const removeMenuItemCounter = (cfg: SessionConfig, p: { menuItemId: string; authEmpId: string }) =>
  postUpdate(cfg, updateMenuItemCounterXml(cfg, { ...p, remove: true }));
