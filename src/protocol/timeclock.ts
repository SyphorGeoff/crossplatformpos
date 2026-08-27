/*
 * Timeclock — clock in/out via <Time_Card_Post> (its own root/DTD, NOT the
 * FinancialCheck/Transactional_Request dispatch). AITransactionManager.m:691
 * (clock-in), :1125 (clock-out). POST text/xml to /ISISPOS/HBroker.
 * Is_Clock_Out 0=in / 1=out; timestamps are "yyyy-MM-dd HH:mm" (minute precision).
 * Success = Status_Code=="100". Clock-out references the open card by Sequence.
 */

import { apiServerAddress, findKey, parseXmlResponse, postXml, textOf } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const DTD = '<!DOCTYPE Time_Card_Post SYSTEM "Transactions/Post_Messages/Time_Card_Post.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

/** yyyy-MM-dd HH:mm — the time-card timestamp format (minute precision). */
export function clockStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ClockResult { ok: boolean; message: string; sequence: string; }

function parse(xml: string): { ok: boolean; message: string; sequence: string } {
  const parsed = parseXmlResponse(xml);
  const code = textOf(findKey(parsed, "Status_Code"));
  return {
    ok: code === "100",
    message: textOf(findKey(parsed, "Status_Text")) || code || "No response",
    sequence: textOf(findKey(parsed, "Sequence")),
  };
}

/** Clock IN. Returns the server's card Sequence (needed for clock-out). */
export async function clockIn(cfg: SessionConfig, p: {
  businessDateId: string; empPosId: string; jobPosId: string; rate: number; teamName?: string;
}, now = new Date()): Promise<ClockResult> {
  const xml = `${XML_HEAD}${DTD}<Time_Card_Post>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", p.businessDateId) + el("Emp_POS_ID", p.empPosId) + el("Job_POS_ID", p.jobPosId) +
    `<Sequence></Sequence>` + el("Clock_In_Date_Time", clockStamp(now)) + el("Clock_Out_Date_Time", "1") +
    el("Tips_Declared", "1") + el("Rate", p.rate.toFixed(2)) + el("Is_Clock_Out", "0") +
    el("Team_Name", p.teamName ?? "") + el("Is_Adjustment", "0") + `</Time_Card_Post>`;
  try { return parse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml)); }
  catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, sequence: "" }; }
}

/** Clock OUT the open card (referenced by Sequence). */
export async function clockOut(cfg: SessionConfig, p: {
  businessDateId: string; empPosId: string; sequence: string; tipsDeclared?: number;
}, now = new Date()): Promise<ClockResult> {
  const tips = p.tipsDeclared !== undefined ? el("Tips_Declared", p.tipsDeclared.toFixed(2)) : "";
  const xml = `${XML_HEAD}${DTD}<Time_Card_Post>` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) +
    el("BusinessDate_ID", p.businessDateId) + el("Emp_POS_ID", p.empPosId) + `<Job_POS_ID></Job_POS_ID>` +
    el("Sequence", p.sequence) + `<Clock_In_Date_Time></Clock_In_Date_Time>` + el("Clock_Out_Date_Time", clockStamp(now)) +
    tips + `<Rate></Rate>` + el("Is_Clock_Out", "1") + el("Is_Adjustment", "0") + `</Time_Card_Post>`;
  try { return parse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml)); }
  catch (e) { return { ok: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, sequence: "" }; }
}
