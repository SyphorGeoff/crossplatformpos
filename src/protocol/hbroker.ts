/*
 * HBroker client — XML over HTTP POST to {enterprise_server}/ISISPOS/HBroker.
 * Every builder reproduces the exact XML the iOS ISIS client concatenates.
 * Citations: aireus_posclient_sql_nocoredata/Classes/TerminalConfigManager.m
 * (tokens) and DefinitionManager.m (definitions). This is the POS twin of the
 * KDS hbroker client; the message set differs (New_Terminal, Standard token,
 * the full Definition_Request with Override_Revision_Seq / change_sequence).
 *
 * Ground-truth-only. No invented endpoints. XML body, Content-type: text/xml.
 */

import { httpRequest } from "@/platform/http";

/** getAPIServerAddress = enterprise_server_url + "/ISISPOS/HBroker"
 *  (TerminalConfigManager.m:810-833, app path const :90/:117). */
export function apiServerAddress(enterpriseServerUrl: string): string {
  return enterpriseServerUrl.replace(/\/$/, "") + "/ISISPOS/HBroker";
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

/** Token_Request Token_Type="New_Terminal" (TerminalConfigManager.m:886).
 *  Enterprise_Code carries the enterprise id; login/password are the operator's. */
export function buildNewTerminalToken(p: {
  isisVer: string; terminalUID: string; enterpriseCode: string; login: string; password: string;
}): string {
  return `${XML_HEAD}<!DOCTYPE Token_Request SYSTEM "Transactions/Post_Messages/Token_Request.dtd"><Token_Request Token_Type="New_Terminal"><ISIS_Ver>${p.isisVer}</ISIS_Ver><Terminal_UID>${p.terminalUID}</Terminal_UID><Enterprise_Code>${p.enterpriseCode}</Enterprise_Code><Enterprise_Login>${p.login}</Enterprise_Login><Enterprise_Password>${p.password}</Enterprise_Password></Token_Request>`;
}

/** Token_Request Token_Type="Standard" (TerminalConfigManager.m:916). The
 *  session token used for definition/transaction calls after assignment.
 *  Note: Enterprise_Login/Password are sent EMPTY here — the terminal is
 *  already known by Store_ID + Terminal_POS_ID + Terminal_UID. */
export function buildStandardToken(p: {
  isisVer: string; storeId: string; terminalPosId: string; terminalUID: string; enterpriseCode: string;
}): string {
  return `${XML_HEAD}<!DOCTYPE Token_Request SYSTEM "Transactions/Post_Messages/Token_Request.dtd"><Token_Request Token_Type="Standard"><ISIS_Ver>${p.isisVer}</ISIS_Ver><Store_ID>${p.storeId}</Store_ID><Terminal_POS_ID>${p.terminalPosId}</Terminal_POS_ID><Terminal_UID>${p.terminalUID}</Terminal_UID><Emp_POS_ID></Emp_POS_ID><Pin></Pin><Enterprise_Code>${p.enterpriseCode}</Enterprise_Code><Enterprise_Login></Enterprise_Login><Enterprise_Password></Enterprise_Password></Token_Request>`;
}

/**
 * Definition_Request (makeDefXML, DefinitionManager.m:2640-2665). Three shapes:
 *  - full pull (first load):     Current_Revision_Seq=0, no change_sequence
 *  - incremental with change_seq: Current_Revision_Seq + change_sequence
 *  - incremental without:         Current_Revision_Seq only
 * The `All` type returns the per-table sequence map (getAllSeq, :1773).
 */
export function buildDefinitionRequest(p: {
  definitionType: string;
  isisVer: string;
  storeId: string;
  securityToken: string;
  currentRevisionSeq?: number;   // default 0 (full load)
  changeSequence?: number;       // omitted unless incremental
}): string {
  const cur = p.currentRevisionSeq ?? 0;
  const head = `${XML_HEAD}<!DOCTYPE Definition_Request SYSTEM "Definitions/Definition_Request.dtd"><Definition_Request Override_Revision_Seq="0" Definition_Type="${p.definitionType}">`;
  const changeSeq = p.changeSequence !== undefined ? `<change_sequence>${p.changeSequence}</change_sequence>` : "";
  return `${head}<ISIS_Ver>${p.isisVer}</ISIS_Ver><Store_ID>${p.storeId}</Store_ID><Current_Revision_Seq>${cur}</Current_Revision_Seq>${changeSeq}<Security_Token>${p.securityToken}</Security_Token></Definition_Request>`;
}

async function send(url: string, xml: string): Promise<string> {
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "Content-type": "text/xml" },
    body: xml,
  });
  return res.text();
}

/* ---- session token renewal ----
 * The server keeps ONE Standard token per terminal and it lapses daily, so any call can come back
 * <Message_Status Status_Code="400">…<Status_Text>Invalid Token</Status_Text>. Geoff 2026-11-11: on a
 * token failure the POS gets a new one; if it cannot, the license was removed or this POS
 * configuration was assigned to another terminal. So every request passes through here: an Invalid
 * Token reply asks the registered renewer (App.tsx) for a fresh token and the same request is sent
 * once more with it. The renewer returns null when it has none to give — a refused token request
 * has by then dropped the terminal's assignment — and the original reply is passed on unchanged. */
export type TokenRenewer = (staleToken: string) => Promise<string | null>;
let tokenRenewer: TokenRenewer | null = null;
export function setTokenRenewer(fn: TokenRenewer | null): void { tokenRenewer = fn; }

export const isInvalidTokenReply = (text: string): boolean =>
  /<Message_Status\b[^>]*\bStatus_Code="400"[^>]*>[\s\S]{0,400}?<Status_Text>\s*Invalid Token/i.test(text);
const sentToken = (xml: string): string => /<Security_Token>([^<]+)<\/Security_Token>/.exec(xml)?.[1] ?? "";

/** POST an XML document (postToServer:/sendSynchronousRequest:, text/xml). An Invalid Token reply is
 *  retried once with a renewed session token. */
export async function postXml(url: string, xml: string): Promise<string> {
  const text = await send(url, xml);
  if (!tokenRenewer || !isInvalidTokenReply(text)) return text;
  const stale = sentToken(xml);
  if (!stale) return text;                       // a token request itself carries no session token
  let fresh: string | null = null;
  try { fresh = await tokenRenewer(stale); } catch { fresh = null; }
  if (!fresh || fresh === stale) return text;
  return send(url, xml.split(`<Security_Token>${stale}</Security_Token>`).join(`<Security_Token>${fresh}</Security_Token>`));
}

/* ---- XML response parsing (NSXMLParser dictionaryStack analog) ---- */

export type XmlDict = { [k: string]: string | XmlDict | Array<string | XmlDict> } & { _text?: string };

/** Parse an XML response into a nested object; repeated siblings collect into
 *  arrays; leaf text becomes the value. A non-XML body (raw token/error text)
 *  returns { _text }. */
export function parseXmlResponse(xmlText: string): XmlDict {
  const trimmed = xmlText.trim();
  if (!trimmed.includes("<")) return { _text: trimmed };
  const doc = new DOMParser().parseFromString(trimmed, "text/xml");
  if (doc.querySelector("parsererror")) return { _text: trimmed };
  const root = doc.documentElement;
  return { [root.tagName]: elementToValue(root) };
}

function elementToValue(el: Element): string | XmlDict {
  const children = Array.from(el.children);
  const attrs = Array.from(el.attributes);
  // Pure leaf, no attributes → the text value (unchanged behavior).
  if (children.length === 0 && attrs.length === 0) return el.textContent ?? "";
  const dict: XmlDict = {};
  // Attributes become plain keys so findKey() reaches them — HBroker carries
  // status on attributes, e.g. <Message_Status Status_Code="100">.
  for (const a of attrs) dict[a.name] = a.value;
  if (children.length === 0) { dict._text = el.textContent ?? ""; return dict; }
  for (const c of children) {
    const v = elementToValue(c);
    const existing = dict[c.tagName];
    if (existing === undefined) dict[c.tagName] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else dict[c.tagName] = [existing, v];
  }
  return dict;
}

export function findKey(
  dict: XmlDict | string | Array<string | XmlDict> | undefined,
  key: string,
): string | XmlDict | Array<string | XmlDict> | undefined {
  if (dict === undefined || typeof dict === "string") return undefined;
  if (Array.isArray(dict)) {
    for (const item of dict) { const hit = findKey(item, key); if (hit !== undefined) return hit; }
    return undefined;
  }
  if (key in dict) return dict[key];
  for (const v of Object.values(dict)) { const hit = findKey(v as XmlDict, key); if (hit !== undefined) return hit; }
  return undefined;
}

export function asList(v: string | XmlDict | Array<string | XmlDict> | undefined): XmlDict[] {
  if (v === undefined || typeof v === "string") return [];
  if (Array.isArray(v)) return v.filter((x): x is XmlDict => typeof x !== "string");
  return [v];
}

export function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
