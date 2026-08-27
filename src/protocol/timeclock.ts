/*
 * Timeclock — clock in/out via <Time_Card_Post> (its own root/DTD, NOT the
 * FinancialCheck/Transactional_Request dispatch). AITransactionManager.m:691
 * (clock-in), :1125 (clock-out). POST text/xml to /ISISPOS/HBroker.
 * Is_Clock_Out 0=in / 1=out; timestamps are "yyyy-MM-dd HH:mm" (minute precision).
 * Success = Status_Code=="100". Clock-out references the open card by Sequence.
 */

import { apiServerAddress, asList, findKey, parseXmlResponse, postXml, textOf } from "./hbroker";
import { escapeXml, type SessionConfig } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const DTD = '<!DOCTYPE Time_Card_Post SYSTEM "Transactions/Post_Messages/Time_Card_Post.dtd">';
const TRANS_DTD = '<!DOCTYPE Transactional_Request SYSTEM "Transactions/Post_Messages/Transactional_Request.dtd">';
const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;

export interface ClockedInEmp {
  empId: string;
  businessDateId: string;
  sequence: string;
  jobId: string;
  defaultRoomId: string;
  clockInTime: string;
  teamName: string;
}

/**
 * The employee's open shift, or null if not clocked in — the login gate check
 * (AITransactionManager checkClockInServerStatus, Trans_Type="Clocked_In_Emps").
 * The returned Job_POS_ID / Default_Dining_Room_POS_ID / Sequence let a
 * clocked-in employee go straight in (skipping the clock-in gate).
 */
export async function fetchClockedInEmp(cfg: SessionConfig, empId: string): Promise<ClockedInEmp | null> {
  const xml = `${XML_HEAD}${TRANS_DTD}<Transactional_Request Trans_Type="Clocked_In_Emps">` +
    el("ISIS_Ver", cfg.isisVer) + el("Store_ID", cfg.storeId) + el("Security_Token", cfg.token) + `</Transactional_Request>`;
  const nn = (v: string) => (/^[<(]?null[>)]?$/i.test(v.trim()) ? "" : v); // server sends literal "null"
  const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
  for (const r of asList(findKey(parsed, "Clocked_In_Emp"))) {
    if (textOf(findKey(r, "Emp_POS_ID")) !== empId) continue;
    return {
      empId,
      businessDateId: nn(textOf(findKey(r, "BusinessDate_ID"))),
      sequence: nn(textOf(findKey(r, "Sequence"))),
      jobId: nn(textOf(findKey(r, "Job_POS_ID"))),
      defaultRoomId: nn(textOf(findKey(r, "Default_Dining_Room_POS_ID"))),
      clockInTime: nn(textOf(findKey(r, "Clock_In_Date_Time"))),
      teamName: nn(textOf(findKey(r, "Team_Name"))),
    };
  }
  return null;
}

/** yyyy-MM-dd HH:mm — the time-card timestamp format (minute precision). */
export function clockStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ClockResult { ok: boolean; alreadyClockedIn: boolean; message: string; sequence: string; }

function parse(xml: string): ClockResult {
  const parsed = parseXmlResponse(xml);
  const code = textOf(findKey(parsed, "Status_Code"));
  const text = textOf(findKey(parsed, "Status_Text"));
  return {
    ok: code === "100",
    // The server reports an existing shift on a duplicate clock-in — that means
    // the employee IS on the clock, so callers treat it as a successful sign-on.
    alreadyClockedIn: /already\s*clocked\s*in/i.test(text),
    message: text || code || "No response",
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
  catch (e) { return { ok: false, alreadyClockedIn: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, sequence: "" }; }
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
  catch (e) { return { ok: false, alreadyClockedIn: false, message: `server unreachable: ${String((e as Error).message ?? e)}`, sequence: "" }; }
}
