/*
 * Native payment processing — the Aireus in-house gift-card & loyalty path
 * (CreditCardManager getXMLForPaymentData: :653, sendRequest: :1168). All native
 * tenders POST a <Payment Type="…"> document to the SAME HBroker endpoint
 * (/ISISPOS/HBroker); third-party gateways instead hit /ISISPOS/ai_givex.jsp or
 * ai_loyalty.jsp — this file is native-only and never uses those.
 *
 * Native selection (gate before calling): Store.GC_Processor contains
 * "isis"/"aireus" (isGC_ISIS); loyalty native = loyalty_Processor is not a
 * known third-party value. Credit cards are deferred (stubbed in the UI).
 *
 * Room-charge/PMS (PMSManager.m) posts to a SEPARATE host
 * (http://{PMS_Address}:{PMS_Port}/OraclePMSProxy/OracleProxy), not HBroker.
 * The builders are here for completeness; M3's UI records room charges offline
 * (the "Room Charge Offline" tender) rather than auto-firing to a live PMS.
 */

import { apiServerAddress, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
import { escapeXml } from "./order";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const PAYMENT_DTD = '<!DOCTYPE Payment SYSTEM "Transactions/Post_Messages/Payment.dtd">';

/** Native gift-card Payment Types (CreditCardManager). */
export type GiftType = "PrePaidBalance" | "PrePaidSale" | "PrePaidReturn" | "PrePaidReload" | "PrePaidIssue";
/** Native loyalty Payment Types (ISISLOYALTY). */
export type LoyaltyType = "LoyaltyBalance" | "LoyaltyRedeem" | "LoyaltyReload" | "LoyaltyActivate";
export type PaymentType = GiftType | LoyaltyType;

export interface PaymentContext {
  enterpriseServerUrl: string;
  isisVer: string;
  storeId: string;
  terminalPosId: string;
  securityToken: string;
  businessDateId: string;
  merchantId: string;         // GC_Merchant_ID / loyalty_MerchantID (RC override upstream)
  merchantPassword: string;   // GCMerchantPassword / loyalty_Merchant_Password
  operatorId: string;         // Employee_POS_ID
  invoiceNo: string;          // check number
  checkKey: string;           // check_key
}

export interface PaymentField { card: string; amount: number; guestNo?: string; }

/** Build a native <Payment Type="…"> (getXMLForPaymentData: :655-828, native subset). */
export function buildPaymentXML(type: PaymentType, ctx: PaymentContext, p: PaymentField): string {
  const el = (n: string, v: string | number) => `<${n}>${escapeXml(String(v))}</${n}>`;
  const body = [
    el("MerchantID", ctx.merchantId),
    el("MerchantPassword", ctx.merchantPassword),
    el("ISIS_Ver", ctx.isisVer),
    el("Store_ID", ctx.storeId),
    el("TerminalID", ctx.terminalPosId),
    el("Security_Token", ctx.securityToken),
    el("InvoiceNo", ctx.invoiceNo),
    el("OperatorID", ctx.operatorId),
    el("Amount", p.amount.toFixed(2)),
    el("AcctNo", p.card),
    el("Terminal_POS_ID", ctx.terminalPosId),
    el("check_key", ctx.checkKey),
    el("BusinessDate_ID", ctx.businessDateId),
    p.guestNo ? el("GuestNo", p.guestNo) : "",
  ].join("");
  return `${XML_HEAD}${PAYMENT_DTD}<Payment Type="${type}">${body}</Payment>`;
}

export interface PaymentResult {
  ok: boolean;
  status: string;             // <PaymentResponse Status="…"> attribute
  balance?: string;           // remaining balance / points
  approvedAmount?: string;
  refNo?: string;
  message: string;
  fields: Record<string, string>;
}

/** A PaymentResponse Status attribute counts as success when it approves. The
 *  exact wording is server-defined; treat these as approvals, everything else
 *  as a decline/error (and surface the raw status). */
const APPROVED = new Set(["approved", "ok", "success", "100", "captured", "0"]);

export function parsePaymentResult(xml: string): PaymentResult {
  const parsed = parseXmlResponse(xml);
  // A <Message_Status Status_Code="…"> reply is an error/refusal (e.g. 500
  // "Check not posted") — success on that shape is 100, not a PaymentResponse.
  const statusCode = textOf(findKey(parsed, "Status_Code"));
  if (statusCode && statusCode !== "100") {
    return { ok: false, status: statusCode, message: textOf(findKey(parsed, "Status_Text")) || `Payment error ${statusCode}`, fields: {} };
  }
  const resp = findKey(parsed, "PaymentResponse");
  const dict: XmlDict = resp && typeof resp !== "string" && !Array.isArray(resp) ? (resp as XmlDict) : (parsed as XmlDict);
  const status = textOf(dict["Status"]);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(dict)) if (typeof v === "string") fields[k] = v;
  const ok = APPROVED.has(status.trim().toLowerCase());
  return {
    ok, status,
    balance: fields["Balance"],
    approvedAmount: fields["ApprovedAmount"],
    refNo: fields["RefNo"],
    message: fields["TextResponse"] || fields["ResponseText"] || fields["Message"] || status || "No response",
    fields,
  };
}

/** POST a native <Payment> to HBroker and parse the PaymentResponse. */
export async function sendPayment(type: PaymentType, ctx: PaymentContext, p: PaymentField): Promise<PaymentResult> {
  try {
    const xml = buildPaymentXML(type, ctx, p);
    const respText = await postXml(apiServerAddress(ctx.enterpriseServerUrl), xml);
    return parsePaymentResult(respText);
  } catch (e) {
    return { ok: false, status: "COMMFAIL", message: `server unreachable: ${String((e as Error).message ?? e)}`, fields: {} };
  }
}

/* ---- Room charge / PMS (OraclePMSProxy — separate host, built for completeness) ---- */

export interface PmsContext {
  pmsAddress: string; pmsPort: string; propertyIdentifier: string;
  revenueCenter: string; waiterId: string; workstationId: string;
}

/** OraclePMSProxy endpoint (PMSManager.m:3475). */
export const pmsUrl = (host: string, port: string): string => `http://${host}:${port}/OraclePMSProxy/OracleProxy`;

/** <PostRequest …/> that posts a room charge (PMSManager.m:2998). Built faithfully;
 *  not auto-fired in M3 (room charges are recorded offline via the tender line). */
export function buildPmsPostRequest(p: {
  ctx: PmsContext; roomNumber: string; lastName: string; amount: number;
  paymentMethod: string; checkNumber: string; covers: string; date: string; time: string; sequenceNumber: string;
}): string {
  const a = (n: string, v: string) => `${n}="${escapeXml(v)}"`;
  return `<PostRequest ${[
    a("RoomNumber", p.roomNumber), a("ReservationId", ""), a("ProfileId", ""), a("LastName", p.lastName),
    a("HotelId", p.ctx.propertyIdentifier), a("RequestType", "1"), a("InquiryInformation", ""),
    a("MatchfromPostList", ""), a("SequenceNumber", p.sequenceNumber), a("TotalAmount", p.amount.toFixed(2)),
    a("CreditLimitOverride", ""), a("PaymentMethod", p.paymentMethod), a("Covers", p.covers),
    a("RevenueCenter", p.ctx.revenueCenter), a("ServingTime", p.time), a("CheckNumber", p.checkNumber),
    a("Date", p.date), a("Time", p.time), a("WaiterId", p.ctx.waiterId), a("WorkstationId", p.ctx.workstationId),
  ].join(" ")} />`;
}
