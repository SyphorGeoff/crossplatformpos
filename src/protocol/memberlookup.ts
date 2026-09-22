/*
 * Member lookup — loyalty/AR member search against the Member Interface server
 * (DefinitionManager getMemberLookupServerURL:4754, SearchCustomerViewController).
 * NOT HBroker: a plain HTTPS GET to
 *   https://{Enterprise_Code}.aireus.com:8443/MemberInterface/MemberLookup
 * ?acctname=<name>  (name search → repeating <Member>) or
 * ?arcode=<card>    (code search → a <MemberLookup> doc with one account).
 * Routed through the same http seam (native OS networking / dev forwarder).
 */

import { httpRequest } from "@/platform/http";
import { asList, findKey, parseXmlResponse, textOf } from "./hbroker";

export interface Member { name: string; arcode: string; addr: string; status: string; }
export interface MemberResult { ok: boolean; members: Member[]; message: string; }

export async function memberLookup(enterpriseCode: string, q: { name?: string; code?: string }): Promise<MemberResult> {
  const base = `https://${(enterpriseCode || "").toLowerCase()}.aireus.com:8443/MemberInterface/MemberLookup`;
  const url = q.code ? `${base}?arcode=${encodeURIComponent(q.code)}` : `${base}?acctname=${encodeURIComponent(q.name ?? "")}`;
  try {
    const res = await httpRequest(url, { method: "GET" });
    if (!res.ok) return { ok: false, members: [], message: `Member server unavailable (${res.status})` };
    const parsed = parseXmlResponse(await res.text());
    const err = textOf(findKey(parsed, "ErrorMessage"));
    if (err) return { ok: false, members: [], message: err };
    // Name search — a list of <Member> nodes.
    const rows = asList(findKey(parsed, "Member"));
    if (rows.length) {
      const members = rows.map((r) => ({
        name: `${textOf(findKey(r, "MainFirst"))} ${textOf(findKey(r, "MainLast"))}`.trim() || textOf(findKey(r, "AcctName")),
        arcode: textOf(findKey(r, "ARCode")),
        addr: textOf(findKey(r, "Addr1")),
        status: textOf(findKey(r, "AcctStat")),
      }));
      return { ok: true, members, message: `${members.length} match${members.length === 1 ? "" : "es"}` };
    }
    // Code search — a single account.
    const result = textOf(findKey(parsed, "Result"));
    const acct = textOf(findKey(parsed, "AcctName")) || `${textOf(findKey(parsed, "MainFirst"))} ${textOf(findKey(parsed, "MainLast"))}`.trim();
    const arcode = textOf(findKey(parsed, "ARCode"));
    if ((/success/i.test(result) || arcode) && (acct || arcode)) {
      return { ok: true, members: [{ name: acct, arcode, addr: "", status: textOf(findKey(parsed, "AcctStat")) }], message: "1 match" };
    }
    return { ok: true, members: [], message: result && /fail/i.test(result) ? "No member found" : "No members found" };
  } catch (e) { return { ok: false, members: [], message: `lookup failed: ${String((e as Error).message ?? e)}` }; }
}
