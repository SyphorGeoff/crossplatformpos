/*
 * Activation / tokens — the POS enrolment flow (TerminalConfigManager.m).
 *   1. New_Terminal token  (getNewToken, :885) — enterprise creds → token
 *   2. …store/terminal selection + assignment (later slice)…
 *   3. Standard token      (getStandardToken, :913) — the session token used
 *      for Definition_Request / transactions after the terminal is known.
 *
 * The security token is read from <Security_Token_Value> in the response (same
 * HBroker element the KDS flow used; confirm against live enox). One-shot calls.
 */

import { apiServerAddress, buildNewTerminalToken, buildStandardToken, findKey, parseXmlResponse, postXml, textOf } from "./hbroker";

export interface TokenResult {
  ok: boolean;
  token: string;
  error?: string;   // <error> / <Status_Text> when the server refuses
}

function readToken(xml: string): TokenResult {
  const parsed = parseXmlResponse(xml);
  const err = textOf(findKey(parsed, "error")) || textOf(findKey(parsed, "Status_Text"));
  const token = textOf(findKey(parsed, "Security_Token_Value")) || textOf(findKey(parsed, "_text"));
  if (!token || err) return { ok: false, token: "", error: err || "no token in response" };
  return { ok: true, token };
}

/** Step 1: enrol the terminal with enterprise credentials. */
export async function requestNewTerminalToken(p: {
  enterpriseServerUrl: string; isisVer: string; terminalUID: string;
  enterpriseCode: string; login: string; password: string;
}): Promise<TokenResult> {
  const xml = buildNewTerminalToken({
    isisVer: p.isisVer, terminalUID: p.terminalUID,
    enterpriseCode: p.enterpriseCode, login: p.login, password: p.password,
  });
  try {
    return readToken(await postXml(apiServerAddress(p.enterpriseServerUrl), xml));
  } catch (e) {
    return { ok: false, token: "", error: `server unreachable: ${String((e as Error).message ?? e)}` };
  }
}

/** Step 3: session token for an assigned terminal. */
export async function requestStandardToken(p: {
  enterpriseServerUrl: string; isisVer: string; storeId: string; terminalPosId: string;
  terminalUID: string; enterpriseCode: string;
}): Promise<TokenResult> {
  const xml = buildStandardToken({
    isisVer: p.isisVer, storeId: p.storeId, terminalPosId: p.terminalPosId,
    terminalUID: p.terminalUID, enterpriseCode: p.enterpriseCode,
  });
  try {
    return readToken(await postXml(apiServerAddress(p.enterpriseServerUrl), xml));
  } catch (e) {
    return { ok: false, token: "", error: `server unreachable: ${String((e as Error).message ?? e)}` };
  }
}
