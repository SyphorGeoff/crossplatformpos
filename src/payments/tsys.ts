/*
 * TSYS — TransIT API 3.0 (Global Payments) card processor behind the seam.
 * Spec text: docs/tsys/*.txt, pulled from developerportal.transit-pass.com
 * (API 3.0 Authentication, GenerateKey, Auth, Sale, Capture, Void, Return,
 * TipAdjustment, IncrementalAuth, Tokenization, ResponseCodes, Restaurant use
 * cases) on 2026-11-05.
 *
 * What this module does today (no device yet):
 *   stored token → Auth / Sale with the TransIT token in cardNumber
 *   finalize     → Capture (base + tip)            tip change → TipAdjustment
 *   bar tab grow → IncrementalAuth                 shrink     → partial Void
 *   void         → Void (full / partial)           refund     → Return with reference
 * The POS never handles a card number (Geoff 2026-11-06): every card is
 * presented on, or keyed into, the payment device. Until the device
 * integration lands, authorize/sale without a stored token return an error
 * and the UI keeps the tender on its offline path.
 *
 * Wire: XML over HTTPS, Content-Type text/xml (TransIT picks the format from
 * the header; fields MUST appear in the spec's order, so requests are built
 * from ordered pairs). Amounts go as dollars with a decimal point ("11.13") —
 * TransIT reads a bare integer as cents. Responses: status PASS/FAIL,
 * responseCode A.... approved (A0002 = partial), D.... declined by the host,
 * E.... format error, F.... interface error.
 *
 * Authentication: every request carries deviceID + transactionKey. The key is
 * merchant-level, never expires, and is a secret — it is NOT in the Store
 * definition (that bundle is pulled to every tablet). It lives in this
 * terminal's local storage, set once by GenerateKey (merchant's TransIT admin
 * user + password, used for that one call and never stored) or pasted from
 * Merchant Center. Until it is set, every call returns an error.
 *
 * TransIT has no "status" call in this spec set and answers synchronously, so
 * status(ref) replays the last result this terminal recorded for that ref;
 * the record also keeps the amounts increment / partial-void math needs.
 */

import { httpRequest } from "@/platform/http";
import { loadJSON, saveJSON } from "@/platform/storage";
import { findKey, parseXmlResponse, textOf } from "@/protocol/hbroker";
import type { ProcessorConfig } from "./config";
import { brandFromText, declined, failed, type CardAmounts, type CardProcessor, type CardRequest, type CardResult, type CheckRef } from "./processor";
import { registerProcessor } from "./select";

export const TSYS_UAT_URL = "https://stagegw.transnox.com/servlets/Transnox_API_server";
export const TSYS_PROD_URL = "https://gateway.transit-pass.com/servlets/TransNox_API_Server";

const KEYS = "payments.tsys.keys.v1";   // { [mid]: transactionKey }
const TXNS = "payments.tsys.txns.v1";   // { [transactionID]: TsysTxn }

/* ---------------- transaction key (per terminal, per MID) ---------------- */

function keys(): Record<string, string> { return loadJSON<Record<string, string>>(KEYS, {}); }

export function tsysKey(mid: string): string { return keys()[mid] ?? ""; }
export function hasTsysKey(mid: string): boolean { return !!tsysKey(mid); }
export function setTsysKey(mid: string, key: string): void { const k = keys(); k[mid] = key.trim(); saveJSON(KEYS, k); }
export function clearTsysKey(mid: string): void { const k = keys(); delete k[mid]; saveJSON(KEYS, k); }

/** GenerateKey: the merchant's TransIT admin user + password, used for this one
 *  call only; the returned transaction key is stored for the MID. */
export async function provisionTsysKey(cfg: ProcessorConfig, userID: string, password: string): Promise<CardResult> {
  const mid = tsysMid(cfg);
  if (!mid) return failed("TSYS Merchant ID is not configured");
  const r = await post(cfg, "GenerateKey", [["mid", mid], ["userID", userID], ["password", password], ["developerID", developerId(cfg)]]);
  if (r.status !== "ok" || !r.raw.transactionKey) return r.status === "ok" ? failed("TransIT returned no transaction key") : r;
  setTsysKey(mid, r.raw.transactionKey);
  return { status: "ok", message: "Transaction key stored" };
}

/* ---------------- config helpers ---------------- */

export function tsysMid(cfg: ProcessorConfig): string { return String(cfg.bundle.mid ?? cfg.merchantId ?? "").trim(); }
export function tsysDeviceId(cfg: ProcessorConfig): string { return String(cfg.bundle.deviceId ?? "").trim(); }
function developerId(cfg: ProcessorConfig): string { return String(cfg.bundle.developerId ?? "").trim(); }
export function tsysUrl(cfg: ProcessorConfig): string { return cfg.testMode ? TSYS_UAT_URL : TSYS_PROD_URL; }

/* ---------------- local transaction record ---------------- */

interface TsysTxn {
  id: string;                // TransIT transactionID (= ref / RecordNo on the wire)
  kind: "auth" | "sale";
  amount: number;            // base amount currently on the transaction
  tip: number;
  authorized: number;        // approved base (partial approvals are less than asked)
  captured: boolean;
  voided: boolean;
  last: CardResult;          // what status(ref) replays
  checkNo: string; tenderKey: string; externalRef: string;
}

function txns(): Record<string, TsysTxn> { return loadJSON<Record<string, TsysTxn>>(TXNS, {}); }
function getTxn(id: string): TsysTxn | undefined { return txns()[id]; }
function putTxn(t: TsysTxn): void { const all = txns(); all[t.id] = t; saveJSON(TXNS, all); }
/** Test/dev helper: forget every recorded TSYS transaction and key. */
export function resetTsys(): void { saveJSON(TXNS, {}); saveJSON(KEYS, {}); }

/* ---------------- wire ---------------- */

type Pair = [string, string | undefined];
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Dollars with a decimal point — a bare integer would be read as cents. */
export const money = (n: number) => round2(n).toFixed(2);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Build one request document from ordered pairs; undefined/empty values are left out. */
export function buildTsysXml(op: string, fields: Pair[]): string {
  const body = fields.filter((f): f is [string, string] => f[1] !== undefined && f[1] !== "").map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("");
  return `<${op}>${body}</${op}>`;
}

interface Reply extends CardResult { raw: Record<string, string>; }

function flat(v: unknown, out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (typeof x === "string") out[k] = x; else flat(x, out); }
  return out;
}

const num = (s: string | undefined): number | undefined => (s && /^\d+(\.\d+)?$/.test(s) ? (s.includes(".") ? Number(s) : Number(s) / 100) : undefined);

/** Classify a TransIT reply into a CardResult. */
export function parseTsysReply(op: string, xml: string): Reply {
  const dict = parseXmlResponse(xml);
  const resp = findKey(dict, `${op}Response`);
  const raw = flat(resp ?? dict);
  if (!resp || !raw.responseCode) {
    const t = textOf(dict._text) || xml.slice(0, 200);
    return { ...failed(`TSYS: unexpected reply${t ? ` — ${t.trim().slice(0, 120)}` : ""}`), raw };
  }
  const code = raw.responseCode; const msg = raw.responseMessage || code;
  const base: Partial<CardResult> = {
    ref: raw.transactionID, recordNo: raw.transactionID, authCode: raw.authCode, last4: raw.maskedCardNumber, brand: brandFromText(raw.cardType),
    token: raw.token, tip: num(raw.tip),
    receipt: raw.customerReceipt || raw.merchantReceipt ? { customer: raw.customerReceipt, merchant: raw.merchantReceipt } : undefined,
  };
  if (raw.status === "PASS" && code.startsWith("A")) return { status: "ok", message: code === "A0002" ? "Partial approval" : msg, ...base, raw };
  if (code.startsWith("D")) return { ...declined(`Declined — ${msg}`, base), raw };
  return { ...failed(`TSYS ${code}: ${msg}`, base), raw };
}

async function post(cfg: ProcessorConfig, op: string, fields: Pair[]): Promise<Reply> {
  let text: string;
  try {
    const res = await httpRequest(`${tsysUrl(cfg)}/${op}`, { method: "POST", headers: { "Content-Type": "text/xml", Accept: "text/xml" }, body: buildTsysXml(op, fields) });
    text = await res.text();
    if (!res.ok && !text.includes("<")) return { ...failed(`TSYS: HTTP ${res.status}`), raw: {} };
  } catch (e) {
    return { ...failed(`TSYS: ${e instanceof Error ? e.message : "network error"}`), raw: {} };
  }
  return parseTsysReply(op, text);
}

/* ---------------- request builders ---------------- */

function auth(cfg: ProcessorConfig): Pair[] { return [["deviceID", tsysDeviceId(cfg)], ["transactionKey", tsysKey(tsysMid(cfg))]]; }
const operatorId = (ctx: CheckRef) => `EMP${ctx.employeePosId}`;                      // min length 3
const laneId = (ctx: CheckRef) => /^\d+$/.test(ctx.terminalPosId) ? ctx.terminalPosId.padStart(8, "0").slice(-8) : undefined;
/** One id per tender line, alphanumeric: TransIT keeps it 24 h for duplicate detection / lookup. */
export const externalRef = (ctx: CheckRef) => `C${ctx.checkNo}T${ctx.tenderKey}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 100);

/** Attended restaurant terminal data (restaurant use case 15 values); the device integration will replace the entry-mode values. */
const KEYED_TERMINAL: Pair[] = [
  ["terminalCapability", "KEYED_ENTRY_ONLY"], ["terminalOperatingEnvironment", "ON_MERCHANT_PREMISES_ATTENDED"],
  ["cardholderAuthenticationMethod", "MANUAL_SIGNATURE"], ["terminalAuthenticationCapability", "NO_CAPABILITY"],
  ["terminalOutputCapability", "PRINT_AND_DISPLAY"], ["maxPinLength", "NOT_SUPPORTED"], ["terminalCardCaptureCapability", "NO_CAPABILITY"],
  ["cardholderPresentDetail", "CARDHOLDER_PRESENT"], ["cardPresentDetail", "CARD_PRESENT"], ["cardDataInputMode", "KEY_ENTERED_INPUT"],
  ["cardholderAuthenticationEntity", "MERCHANT_CARD_ACCEPTOR_SIGNATURE"], ["cardDataOutputCapability", "NONE"],
];

/** The stored TransIT token stands in for the card; a card number never reaches this code. */
function cardFields(req: CardRequest): Pair[] { return [["cardNumber", req.token]]; }

function paymentRequest(cfg: ProcessorConfig, req: CardRequest, kind: "auth" | "sale"): Pair[] {
  const tokens = cfg.bundle.tokens === true || cfg.bundle.tokenRequired === true;
  return [
    ...auth(cfg), ["cardDataSource", "MANUAL"], ["transactionAmount", money(req.amount)], ["tip", req.tip ? money(req.tip) : undefined], ["currencyCode", "USD"],
    ...cardFields(req),
    ["externalReferenceID", externalRef(req)], ["operatorID", operatorId(req)], ["orderNumber", req.checkNo], ["partialAuthSupport", "YES"],
    ["tokenRequired", tokens ? "Y" : undefined],
    ...KEYED_TERMINAL, ["developerID", developerId(cfg)], ["laneID", laneId(req)], ["authorizationIndicator", kind === "auth" ? "PREAUTH" : undefined],
  ];
}

/* ---------------- the processor ---------------- */

export function makeTsys(cfg: ProcessorConfig): CardProcessor {
  const ready = (): CardResult | null => {
    if (!tsysDeviceId(cfg) || !tsysMid(cfg)) return failed("TSYS Merchant ID / Device ID are not configured in the back office");
    if (!hasTsysKey(tsysMid(cfg))) return failed("TSYS transaction key is not set on this terminal");
    return null;
  };

  async function start(req: CardRequest, kind: "auth" | "sale"): Promise<CardResult> {
    const notReady = ready(); if (notReady) return notReady;
    if (!req.token) return failed("TSYS card-present entry needs the payment device (not integrated yet) — use an offline tender");
    const existing = Object.values(txns()).find((t) => t.externalRef === externalRef(req) && !t.voided);
    if (existing) return existing.last;                                   // idempotent per tender line
    const r = await post(cfg, kind === "auth" ? "Auth" : "Sale", paymentRequest(cfg, req, kind));
    if (r.status !== "ok" || !r.ref) return r;
    const approved = num(r.raw.processedAmount) ?? req.amount;
    const authorized = round2(Math.min(approved, req.amount));
    const result: CardResult = {
      ...r, authorizedAmount: authorized, tip: req.tip ?? 0,
      capturedAmount: kind === "sale" ? round2(authorized + (req.tip ?? 0)) : undefined,
      message: authorized < req.amount - 0.005 ? `Partial approval — ${money(authorized)} of ${money(req.amount)}` : "Approved",
    };
    delete (result as Partial<Reply>).raw;
    putTxn({ id: r.ref, kind, amount: authorized, tip: req.tip ?? 0, authorized, captured: kind === "sale", voided: false, last: result, checkNo: req.checkNo, tenderKey: req.tenderKey, externalRef: externalRef(req) });
    return result;
  }

  const remember = (t: TsysTxn | undefined, patch: Partial<TsysTxn>, result: CardResult): CardResult => {
    if (t) putTxn({ ...t, ...patch, last: { ...t.last, ...result, receipt: result.receipt ?? t.last.receipt } });
    return result;
  };
  const strip = (r: Reply): CardResult => { const { raw: _raw, ...rest } = r; return rest; };

  return {
    name: "tsys",
    authorize: (req) => start(req, "auth"),
    sale: (req) => start(req, "sale"),

    async capture(ref, amounts: CardAmounts, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      if (t?.voided) return failed("Transaction was voided");
      if (t?.captured) return failed("Already captured");
      const r = await post(cfg, "Capture", [...auth(cfg), ["transactionAmount", money(amounts.amount)], ["tip", amounts.tip ? money(amounts.tip) : undefined], ["transactionID", ref], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)]]);
      if (r.status !== "ok") return strip(r);
      const total = round2(amounts.amount + amounts.tip);
      return remember(t, { amount: round2(amounts.amount), tip: round2(amounts.tip), captured: true }, { ...strip(r), ref, recordNo: ref, authCode: r.authCode ?? t?.last.authCode, last4: r.last4 ?? t?.last.last4, brand: r.brand ?? t?.last.brand, authorizedAmount: t?.authorized ?? amounts.amount, capturedAmount: total, tip: amounts.tip, message: "Captured" });
    },

    /** After capture: tip → TipAdjustment; a smaller base → partial Void of the difference. Growing a captured sale is not possible. */
    async adjust(ref, amounts: CardAmounts, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      if (t?.voided) return failed("Transaction was voided");
      let cur = t ? { amount: t.amount, tip: t.tip } : undefined;
      if (cur && amounts.amount > cur.amount + 0.005) return failed("A captured TSYS sale cannot be increased — take a second payment for the difference");
      // No local record (another terminal took the payment): only the tip can be adjusted.
      if (cur && amounts.amount < cur.amount - 0.005) {
        const diff = round2(cur.amount - amounts.amount);
        const r = await post(cfg, "Void", [...auth(cfg), ["transactionAmount", money(diff)], ["transactionID", ref], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)], ["voidReason", "PARTIAL_REVERSAL"]]);
        if (r.status !== "ok") return strip(r);
        cur = { amount: round2(amounts.amount), tip: cur.tip };
        remember(t, { amount: cur.amount }, { ...t!.last, capturedAmount: round2(cur.amount + cur.tip), message: "Adjusted" });
      }
      if (!cur || Math.abs(amounts.tip - cur.tip) > 0.005) {
        const r = await post(cfg, "TipAdjustment", [...auth(cfg), ["tip", money(amounts.tip)], ["transactionID", ref], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)]]);
        if (r.status !== "ok") return strip(r);
        cur = { amount: cur?.amount ?? num(r.raw.totalAmount) ?? amounts.amount, tip: round2(amounts.tip) };
      }
      const total = round2(cur.amount + cur.tip);
      return remember(t, { amount: cur.amount, tip: cur.tip }, { status: "ok", message: "Adjusted", ref, recordNo: ref, authCode: t?.last.authCode, last4: t?.last.last4, brand: t?.last.brand, authorizedAmount: t?.authorized, capturedAmount: total, tip: cur.tip });
    },

    /** Raise an open auth: TransIT takes the increment, not the new total. */
    async increment(ref, newAmount, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      if (!t) return failed("Unknown TSYS authorization on this terminal");
      if (t.captured || t.voided) return failed("Not an open authorization");
      const diff = round2(newAmount - t.authorized);
      if (diff <= 0) return failed("New amount must be higher than the authorization");
      const r = await post(cfg, "IncrementalAuth", [...auth(cfg), ["transactionID", ref], ["transactionAmount", money(diff)], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)]]);
      if (r.status !== "ok") return strip(r);
      const total = num(r.raw.totalAmount) ?? round2(t.authorized + diff);
      return remember(t, { amount: total, authorized: total }, { ...t.last, ...strip(r), ref, recordNo: ref, authCode: r.authCode ?? t.last.authCode, authorizedAmount: total, message: "Authorization increased" });
    },

    /** Full void (no amount) or partial void of `amount`. TransIT voids are always approved. */
    async cancel(ref, ctx, amount) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      const partial = amount !== undefined && t !== undefined && amount < t.amount + t.tip - 0.005;
      const r = await post(cfg, "Void", [...auth(cfg), ["transactionAmount", partial ? money(amount!) : undefined], ["transactionID", ref], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)], ["voidReason", partial ? "PARTIAL_REVERSAL" : "POST_AUTH_USER_DECLINE"]]);
      if (r.status !== "ok") return strip(r);
      if (partial) {
        const left = round2(t!.amount - amount!);
        return remember(t, { amount: left }, { ...t!.last, capturedAmount: t!.captured ? round2(left + t!.tip) : undefined, authorizedAmount: left, message: "Partially voided" });
      }
      return remember(t, { voided: true }, { status: "cancelled", message: "Voided", ref, recordNo: ref, authCode: t?.last.authCode, last4: t?.last.last4, brand: t?.last.brand });
    },

    /** Return with reference: TransIT voids instead when the sale is still unsettled (A0014). */
    async refund(ref, amount, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      if (t && !t.captured) return failed("Not captured — void it instead");
      const r = await post(cfg, "Return", [...auth(cfg), ["transactionAmount", money(amount)], ["transactionID", ref], ["operatorID", operatorId(ctx)], ["developerID", developerId(cfg)]]);
      if (r.status !== "ok") return strip(r);
      const newRef = r.ref && r.ref !== ref ? r.ref : `${ref}R`;
      return { ...strip(r), ref: newRef, recordNo: newRef, last4: r.last4 ?? t?.last.last4, brand: r.brand ?? t?.last.brand, capturedAmount: num(r.raw.returnedAmount) ?? amount, message: r.raw.responseCode === "A0014" ? "Voided (not yet settled)" : "Refunded" };
    },

    async status(ref) {
      const t = getTxn(ref);
      if (!t) return failed("Unknown TSYS transaction on this terminal");
      return t.last;
    },
  };
}

registerProcessor("tsys", makeTsys);
