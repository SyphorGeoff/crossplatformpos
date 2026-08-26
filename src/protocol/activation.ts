/*
 * Activation / tokens — the POS enrolment chain (TerminalConfigManager.m),
 * with the shapes proven live for the KDS reused where identical.
 *
 *   1. New_Terminal token      (getNewToken, :885)   — enterprise creds → token
 *   2. Store_List              (makeXMLMessage, :858/:942) → pick store
 *   3. Terminals               (makeTerminalMessage, :1065) → pick terminal
 *        POS terminals filter Is_Licensed=="1" (:1042; kiosk="3", KDS="2")
 *   4. Terminal_Assignment     (assignTerminal, :1090, Override_Existing="1")
 *   5. Standard token          (getStandardToken, :916) — session token
 *
 * Faithful quirks: Store_List sends ISIS_Ver as "version:enterprise_user" and
 * BOTH Store_List/Terminals use lowercase attr `Override_Revision_seq` (the def
 * sync uses capital `Override_Revision_Seq` — see hbroker.buildDefinitionRequest).
 * Token from <Security_Token_Value>; <error>/<Status_Text> = refusal.
 */

import { apiServerAddress, buildNewTerminalToken, buildStandardToken, findKey, parseXmlResponse, postXml, textOf, asList, type XmlDict } from "./hbroker";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export interface TokenResult { ok: boolean; token: string; error?: string; }
export interface StorePick { id: string; name: string; }
export interface TerminalPick { id: string; name: string; licensed: string; }

function readToken(xml: string): TokenResult {
  const parsed = parseXmlResponse(xml);
  const err = textOf(findKey(parsed, "error")) || textOf(findKey(parsed, "Status_Text"));
  const token = textOf(findKey(parsed, "Security_Token_Value")) || textOf(findKey(parsed, "_text"));
  if (!token || err) return { ok: false, token: "", error: err || "no token in response" };
  return { ok: true, token };
}

/** Store_List request (makeXMLMessage, :942) — ISIS_Ver="ver:user", Store_ID=enterprise id. */
function buildStoreListRequest(p: { isisVer: string; enterpriseUser: string; enterpriseCode: string; token: string; }): string {
  return `${XML_HEAD}<!DOCTYPE Definition_Request SYSTEM "Definitions/Definition_Request.dtd"><Definition_Request Override_Revision_seq="0" Definition_Type="Store_List"><ISIS_Ver>${p.isisVer}:${p.enterpriseUser}</ISIS_Ver><Store_ID>${p.enterpriseCode}</Store_ID><Current_Revision_Seq>0</Current_Revision_Seq><Security_Token>${p.token}</Security_Token></Definition_Request>`;
}

/** Terminals request (makeTerminalMessage, :1065) — Store_ID = picked store id. */
function buildTerminalsRequest(p: { isisVer: string; storeId: string; token: string; }): string {
  return `${XML_HEAD}<!DOCTYPE Definition_Request SYSTEM "Definitions/Definition_Request.dtd"><Definition_Request Override_Revision_seq="0" Definition_Type="Terminals"><ISIS_Ver>${p.isisVer}</ISIS_Ver><Store_ID>${p.storeId}</Store_ID><Current_Revision_Seq>0</Current_Revision_Seq><Security_Token>${p.token}</Security_Token></Definition_Request>`;
}

/** Terminal_Assignment (:1090) — Authorizing_Emp_POS_ID is the enterprise user. */
export function buildTerminalAssignment(p: {
  isisVer: string; storeId: string; token: string; terminalPosId: string; terminalUID: string; authorizingUser: string;
}): string {
  return `${XML_HEAD}<!DOCTYPE Terminal_Assignment SYSTEM "Transactions/Post_Messages/Terminal_Assignment.dtd"><Terminal_Assignment Override_Existing="1"><ISIS_Ver>${p.isisVer}</ISIS_Ver><Store_ID>${p.storeId}</Store_ID><Security_Token>${p.token}</Security_Token><Terminal_POS_ID>${p.terminalPosId}</Terminal_POS_ID><Terminal_UID>${p.terminalUID}</Terminal_UID><Authorizing_Emp_POS_ID>${p.authorizingUser}</Authorizing_Emp_POS_ID></Terminal_Assignment>`;
}

/** Step 1 — enrol. */
export async function requestNewTerminalToken(p: {
  enterpriseServerUrl: string; isisVer: string; terminalUID: string; enterpriseCode: string; login: string; password: string;
}): Promise<TokenResult> {
  const xml = buildNewTerminalToken({ isisVer: p.isisVer, terminalUID: p.terminalUID, enterpriseCode: p.enterpriseCode, login: p.login, password: p.password });
  try { return readToken(await postXml(apiServerAddress(p.enterpriseServerUrl), xml)); }
  catch (e) { return { ok: false, token: "", error: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** Step 2 — store list (rootObj /Store_List, node ./Store). */
export async function fetchStoreList(p: {
  enterpriseServerUrl: string; isisVer: string; enterpriseUser: string; enterpriseCode: string; token: string;
}): Promise<StorePick[]> {
  const xml = buildStoreListRequest(p);
  const parsed = parseXmlResponse(await postXml(apiServerAddress(p.enterpriseServerUrl), xml));
  return asList(findKey(parsed, "Store"))
    .map((r: XmlDict) => ({
      id: textOf(findKey(r, "Store_ID")),
      name: textOf(findKey(r, "Store_Identification") ?? findKey(r, "Store_Name")) || textOf(findKey(r, "Store_ID")),
    }))
    .filter((s) => s.id);
}

/** Step 3 — terminals for a store, filtered to POS-licensed (Is_Licensed=="1"). */
export async function fetchTerminals(p: {
  enterpriseServerUrl: string; isisVer: string; storeId: string; token: string;
}): Promise<TerminalPick[]> {
  const xml = buildTerminalsRequest(p);
  const parsed = parseXmlResponse(await postXml(apiServerAddress(p.enterpriseServerUrl), xml));
  return asList(findKey(parsed, "Terminal"))
    .map((r: XmlDict) => ({
      id: textOf(findKey(r, "POS_ID")),
      name: textOf(findKey(r, "Name") ?? findKey(r, "Terminal_Name")) || textOf(findKey(r, "POS_ID")),
      licensed: textOf(findKey(r, "Is_Licensed")),
    }))
    .filter((t) => t.id && t.licensed === "1");
}

/** Step 4 — bind this device to the terminal. Returns any server error. */
export async function assignTerminal(p: {
  enterpriseServerUrl: string; isisVer: string; storeId: string; token: string; terminalPosId: string; terminalUID: string; authorizingUser: string;
}): Promise<{ ok: boolean; error?: string }> {
  const xml = buildTerminalAssignment(p);
  try {
    const parsed = parseXmlResponse(await postXml(apiServerAddress(p.enterpriseServerUrl), xml));
    // Success is a Message_Status with Status_Code 100 ("Terminal Authorized.
    // Please Wait" — verified live vs enox). HBroker uses 100 for OK/info and
    // 4xx/5xx for failures; an <error> element is also a failure.
    const explicitErr = textOf(findKey(parsed, "error"));
    const code = textOf(findKey(parsed, "Status_Code"));
    const statusText = textOf(findKey(parsed, "Status_Text"));
    if (explicitErr) return { ok: false, error: explicitErr };
    if (code && Number(code) >= 400) return { ok: false, error: statusText || `status ${code}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}

/** Step 5 — session token for the assigned terminal. */
export async function requestStandardToken(p: {
  enterpriseServerUrl: string; isisVer: string; storeId: string; terminalPosId: string; terminalUID: string; enterpriseCode: string;
}): Promise<TokenResult> {
  const xml = buildStandardToken({ isisVer: p.isisVer, storeId: p.storeId, terminalPosId: p.terminalPosId, terminalUID: p.terminalUID, enterpriseCode: p.enterpriseCode });
  try { return readToken(await postXml(apiServerAddress(p.enterpriseServerUrl), xml)); }
  catch (e) { return { ok: false, token: "", error: `server unreachable: ${String((e as Error).message ?? e)}` }; }
}
