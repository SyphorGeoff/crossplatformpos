/*
 * Stripe — server-driven Stripe Terminal behind the card-processor seam.
 *
 * The tablet talks to the Stripe REST API directly (same shape as tsys.ts):
 *   authorize → PaymentIntent (card_present, capture_method manual) handed to the
 *               reader with process_payment_intent; `pending` until the reader
 *               action finishes and the intent reaches requires_capture
 *   sale      → same with capture_method automatic (one-shot; the reader may
 *               prompt for the tip when the tender asks for one)
 *   capture   → /capture with amount_to_capture = base + tip (overcapture carries
 *               a tip above the authorization: up to 50% or $50, US restaurants)
 *   increment → /increment_authorization to the new total (bar tabs)
 *   adjust    → after capture only DOWN is possible (partial refund); up → error
 *   cancel    → reader cancel_action while in progress, /cancel while uncaptured,
 *               refund once captured (Stripe has no void after capture)
 *   refund    → /refunds against the intent
 *   status    → GET the intent (+ the reader action while the card is being read)
 *
 * Credentials come from the back-office Credit Card interface — the Store's
 * processor bundle: { accountId, locationId, secretKey, publishableKey,
 * testMode }, entered once for every Aireus client. secretKey is the account's
 * secret or restricted key (PaymentIntents write, Terminal write, Charges
 * read). accountId starting "acct_" is a Connect account and goes in the
 * Stripe-Account header; empty means the key belongs to the store's own
 * account. locationId is used when registering readers.
 *
 * Reader: Terminal TyroTerminalID (tmr_…), or the terminal-local reader set in
 * card setup (the simulated reader during testing). In test mode a simulated
 * reader gets its card presented by this driver right after the hand-off, so
 * the whole flow runs from the POS; the amount's cents pick the test card:
 *   .99 declined (card_declined)   .98 processing_error   .97 insufficient funds
 *   .96 never presented (stays pending until cancelled)   .95 Amex   .94 Mastercard
 *
 * Keyed entry: the S700 is PCI-listed for MO/TO keyed entry, but Stripe's
 * server-driven API has no switch for it (process_config carries only tipping,
 * customer cancel and redisplay), so `deviceKeyedEntry` is accepted and ignored
 * until Stripe enables keyed entry on the account/reader.
 *
 * Idempotency: every POST carries an Idempotency-Key built from the tender
 * line's key and the operation, so a retry after a timeout returns the original
 * result instead of charging twice.
 *
 * Amounts: the seam speaks dollars; Stripe wants integer cents.
 */

import { httpRequest } from "@/platform/http";
import { loadJSON, saveJSON } from "@/platform/storage";
import type { ProcessorConfig } from "./config";
import { brandFromText, declined, failed, type CardAmounts, type CardProcessor, type CardRequest, type CardResult, type CheckRef } from "./processor";
import { registerProcessor } from "./select";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";
export const SIMULATED_READER_CODE = "simulated-wpe";

const READER = "payments.stripe.reader.v1"; // terminal-local reader id (overrides an empty TyroTerminalID)
const TXNS = "payments.stripe.txns.v1";     // { [paymentIntentId]: StripeTxn }

/* ---------------- credentials (from the bundle) ---------------- */

export function stripeKey(cfg: ProcessorConfig): string { return String(cfg.bundle.secretKey ?? "").trim(); }
export function hasStripeKey(cfg: ProcessorConfig): boolean { return !!stripeKey(cfg); }
/** What the setup screen shows for the account: the Connect account id, else the Store's merchant id. */
export function stripeAccountLabel(cfg: ProcessorConfig): string { return String(cfg.bundle.accountId || cfg.merchantId || "").trim() || "own account"; }
/** "test" / "live" from the key prefix (sk_test_, rk_live_ …), "" when unreadable. */
export function stripeKeyMode(key: string): "test" | "live" | "" {
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return "";
}
export function stripeLocalReader(): string { return loadJSON<string>(READER, ""); }
export function setStripeLocalReader(id: string): void { saveJSON(READER, id.trim()); }
export function stripeConnectAccount(cfg: ProcessorConfig): string { const a = String(cfg.bundle.accountId ?? "").trim(); return a.startsWith("acct_") ? a : ""; }
export function stripeLocation(cfg: ProcessorConfig): string { return String(cfg.bundle.locationId ?? "").trim(); }

/* ---------------- local transaction record ---------------- */

interface StripeTxn {
  pi: string; kind: "auth" | "sale"; readerId: string; simulated: boolean; presented: boolean;
  checkNo: string; tenderKey: string; amount: number; tip: number;
}
function txns(): Record<string, StripeTxn> { return loadJSON<Record<string, StripeTxn>>(TXNS, {}); }
function getTxn(pi: string): StripeTxn | undefined { return txns()[pi]; }
function putTxn(t: StripeTxn): void { const all = txns(); all[t.pi] = t; saveJSON(TXNS, all); }
/** Test/dev helper: forget every recorded Stripe transaction, the local reader and cached currencies. */
export function resetStripe(): void { saveJSON(TXNS, {}); saveJSON(READER, ""); resetStripeCurrency(); presentRefunds.clear(); }

/* ---------------- wire ---------------- */

const round2 = (n: number) => Math.round(n * 100) / 100;
export const cents = (dollars: number) => Math.round(round2(dollars) * 100);
const dollars = (c: number | null | undefined): number | undefined => (typeof c === "number" ? round2(c / 100) : undefined);

type Params = Record<string, unknown>;

/** Stripe's form encoding: nested objects as a[b][c], arrays as a[]=…; undefined/null left out. */
export function encodeForm(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) { for (const x of v) parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(x))}`); }
    else if (typeof v === "object") { const inner = encodeForm(v as Params, key); if (inner) parts.push(inner); }
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export interface StripeError { type?: string; code?: string; decline_code?: string; message?: string; }
export interface StripeReply { ok: boolean; status: number; body: Record<string, unknown>; error?: StripeError; }

async function call(cfg: ProcessorConfig, method: "GET" | "POST", path: string, params: Params = {}, idempotencyKey?: string): Promise<StripeReply> {
  const key = stripeKey(cfg);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION, Accept: "application/json" };
  const acct = stripeConnectAccount(cfg);
  if (acct) headers["Stripe-Account"] = acct;
  if (idempotencyKey && method === "POST") headers["Idempotency-Key"] = idempotencyKey.slice(0, 255);
  const q = encodeForm(params);
  let url = `${STRIPE_API}${path}`;
  let body: string | undefined;
  if (method === "GET") { if (q) url += `?${q}`; }
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; body = q; }
  let text = "";
  let status = 0;
  try {
    const res = await httpRequest(url, { method, headers, body });
    status = res.status; text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, body: {}, error: { type: "network_error", message: e instanceof Error ? e.message : "network error" } };
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { parsed = {}; }
  if (status >= 200 && status < 300) return { ok: true, status, body: parsed };
  const err = (parsed.error as StripeError | undefined) ?? { type: "api_error", message: text ? text.slice(0, 160) : `HTTP ${status}` };
  return { ok: false, status, body: parsed, error: err };
}

/** A failed call → CardResult: card_error = declined (the issuer said no), anything else = error. */
function replyFailure(r: StripeReply, ref?: string): CardResult {
  const e = r.error ?? {};
  const msg = e.message || e.code || `HTTP ${r.status}`;
  if (e.type === "card_error") return declined(`Declined — ${e.decline_code ? `${e.decline_code.replace(/_/g, " ")}: ` : ""}${msg}`, { ref });
  return failed(`Stripe: ${msg}`, { ref });
}

/* ---------------- object readers ---------------- */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const numv = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** The latest_charge of an intent (expanded) and its card details. A credit card's details sit under
 *  card_present; an Interac (debit) card's sit under interac_present with the same field names
 *  (brand, last4, read_method, receipt). */
function chargeOf(pi: Obj): { charge: Obj; card: Obj } {
  const charge = obj(pi.latest_charge);
  const details = obj(charge.payment_method_details);
  const card = obj(str(details.type) === "interac_present" ? details.interac_present : details.card_present);
  return { charge, card };
}

/** Interac (debit) charges can only be refunded with the card present on the reader: Stripe refuses the API. */
const isInterac = (pi: Obj): boolean => str(obj(obj(pi.latest_charge).payment_method_details).type) === "interac_present";
/** A refund the API refused because it has to be made in person. */
const refusedInPerson = (r: StripeReply): boolean => /in[- ]person|card[- ]present|interac/i.test(`${r.error?.message ?? ""} ${r.error?.code ?? ""}`);
const needsPresent = (ref: string, amountCents: number): CardResult =>
  failed("This payment can only be refunded with the card present on the reader", { ref, needsCardPresent: { amount: round2(amountCents / 100) } });
/** Card-present refunds in flight: payment id → the reader prompting for the card. */
const presentRefunds = new Map<string, { readerId: string }>();

/** EMV receipt lines a slip prints (same text for customer and merchant copies). */
export function receiptLines(card: Obj): string | undefined {
  const r = obj(card.receipt);
  const lines: string[] = [];
  if (str(r.application_preferred_name)) lines.push(`${r.application_preferred_name}`);
  if (str(r.dedicated_file_name)) lines.push(`AID ${r.dedicated_file_name}`);
  if (str(r.account_type)) lines.push(`ACCOUNT ${r.account_type}`);   // credit / checking / prepaid — card networks require it on receipts outside the US
  if (str(r.authorization_code)) lines.push(`AUTH ${r.authorization_code}`);
  if (str(r.terminal_verification_results)) lines.push(`TVR ${r.terminal_verification_results}`);
  if (str(r.transaction_status_information)) lines.push(`TSI ${r.transaction_status_information}`);
  if (str(r.application_cryptogram)) lines.push(`AC ${r.application_cryptogram}`);
  if (str(r.cardholder_verification_method)) lines.push(`CVM ${String(r.cardholder_verification_method).replace(/_/g, " ")}`);
  if (str(card.read_method)) lines.push(`ENTRY ${String(card.read_method).replace(/_/g, " ")}`);
  return lines.length ? lines.join("\n") : undefined;
}

/** Map a PaymentIntent (latest_charge expanded) to the seam's result. `waitingText` is the pending message while the reader works. */
export function intentResult(pi: Obj, waitingText = "Present the card on the reader…"): CardResult {
  const id = str(pi.id);
  const status = str(pi.status) ?? "";
  const { charge, card } = chargeOf(pi);
  const r = obj(card.receipt);
  const captured = charge.captured === true;
  const base: Partial<CardResult> = {
    ref: id, recordNo: str(charge.id) ?? id,
    authCode: str(r.authorization_code), last4: str(card.last4), brand: isInterac(pi) ? "INTERAC" : brandFromText(str(card.brand) ?? str(card.network)),
    authorizedAmount: dollars(numv(card.amount_authorized)) ?? dollars(numv(pi.amount)),
    capturedAmount: captured ? dollars(numv(charge.amount_captured)) : undefined,
    tip: dollars(numv(obj(obj(pi.amount_details).tip).amount)),
  };
  const emv = receiptLines(card);
  if (emv) base.receipt = { customer: emv, merchant: emv };
  const lpe = obj(pi.last_payment_error);
  if (status === "canceled") return { status: "cancelled", message: "Cancelled", ...base };
  if (status === "succeeded") return { status: "ok", message: "Approved", ...base };
  if (status === "requires_capture") return { status: "ok", message: "Authorized", ...base };
  if (Object.keys(lpe).length) {
    const msg = str(lpe.message) || str(lpe.code) || "declined";
    const dc = str(lpe.decline_code);
    return lpe.type === "card_error" ? declined(`Declined — ${dc ? `${dc.replace(/_/g, " ")}: ` : ""}${msg}`, base) : failed(`Stripe: ${msg}`, base);
  }
  if (status === "processing") return { status: "pending", message: "Processing…", ...base };
  return { status: "pending", message: waitingText, ...base };
}

/* ---------------- test cards (simulated reader) ---------------- */

/** The simulated card the amount's cents pick (mirrors the mock's steering). */
export function testCardFor(amount: number): string | null {
  switch (Math.round(amount * 100) % 100) {
    case 99: return "4000000000000002";   // card_declined
    case 98: return "4000000000000119";   // processing_error
    case 97: return "4000000000009995";   // insufficient_funds
    case 96: return null;                 // never presented → stays pending
    case 95: return "378282246310005";    // Amex
    case 94: return "5555555555554444";   // Mastercard
    default: return "4242424242424242";   // Visa
  }
}

/* ---------------- reader helpers (card setup screen + tests) ---------------- */

export interface ReaderInfo { id: string; label: string; deviceType: string; status: string; simulated: boolean; actionStatus?: string; actionType?: string; failureCode?: string; failureMessage?: string; }

function readerInfo(r: Obj): ReaderInfo {
  const a = obj(r.action);
  const deviceType = str(r.device_type) ?? "";
  return {
    id: str(r.id) ?? "", label: str(r.label) ?? "", deviceType, status: str(r.status) ?? "", simulated: deviceType.startsWith("simulated_"),
    actionStatus: str(a.status), actionType: str(a.type), failureCode: str(a.failure_code), failureMessage: str(a.failure_message),
  };
}

export async function getReader(cfg: ProcessorConfig, readerId: string): Promise<{ ok: true; reader: ReaderInfo } | { ok: false; message: string }> {
  const r = await call(cfg, "GET", `/terminal/readers/${encodeURIComponent(readerId)}`);
  if (!r.ok) return { ok: false, message: r.error?.message ?? `HTTP ${r.status}` };
  return { ok: true, reader: readerInfo(r.body) };
}

/** Register a reader to the bundle's location: the pairing code the device shows, or the simulated reader. */
export async function registerReader(cfg: ProcessorConfig, registrationCode: string, label: string): Promise<{ ok: true; reader: ReaderInfo } | { ok: false; message: string }> {
  const location = stripeLocation(cfg);
  const r = await call(cfg, "POST", "/terminal/readers", { registration_code: registrationCode.trim(), label: label.trim() || undefined, location: location || undefined });
  if (!r.ok) return { ok: false, message: r.error?.message ?? `HTTP ${r.status}` };
  return { ok: true, reader: readerInfo(r.body) };
}

/** List the readers the key can see (optionally at the bundle's location). */
export async function listReaders(cfg: ProcessorConfig): Promise<{ ok: true; readers: ReaderInfo[] } | { ok: false; message: string }> {
  const location = stripeLocation(cfg);
  const r = await call(cfg, "GET", "/terminal/readers", { limit: 50, location: location || undefined });
  if (!r.ok) return { ok: false, message: r.error?.message ?? `HTTP ${r.status}` };
  const data = Array.isArray(r.body.data) ? (r.body.data as Obj[]) : [];
  return { ok: true, readers: data.map(readerInfo) };
}

/** Test mode only: simulate the cardholder presenting a card on a simulated reader. */
export async function presentTestCard(cfg: ProcessorConfig, readerId: string, number: string): Promise<StripeReply> {
  return call(cfg, "POST", `/test_helpers/terminal/readers/${encodeURIComponent(readerId)}/present_payment_method`, { type: "card_present", card_present: { number } });
}

/** Account check for the setup screen: the key works and its mode matches the store. */
export async function checkStripeKey(cfg: ProcessorConfig): Promise<{ ok: boolean; message: string; mode: "test" | "live" | "" }> {
  const key = stripeKey(cfg);
  const mode = stripeKeyMode(key);
  if (!key) return { ok: false, message: "No Stripe secret key in the back office (Credit Card interface)", mode };
  if (mode && (mode === "test") !== cfg.testMode) return { ok: false, message: `Key is ${mode} mode but the store is ${cfg.testMode ? "test" : "live"} mode`, mode };
  const r = await call(cfg, "GET", "/terminal/locations", { limit: 1 });
  if (!r.ok) return { ok: false, message: r.error?.message ?? `HTTP ${r.status}`, mode };
  return { ok: true, message: `Key OK (${mode || "unknown"} mode)`, mode };
}

/* ---------------- currency ---------------- */

/* Terminal charges must be in the Stripe account's own currency (a Canadian account rejects
 * card_present in usd: "not supported in CA", seen 2026-11-06). The bundle may name it
 * (`currency`); otherwise the account's default_currency is read once per key and cached. */
const currencyCache = new Map<string, string>();
export async function stripeCurrency(cfg: ProcessorConfig): Promise<string> {
  const fromBundle = String(cfg.bundle.currency ?? "").trim().toLowerCase();
  if (fromBundle) return fromBundle;
  const cacheKey = `${stripeConnectAccount(cfg)}|${stripeKey(cfg)}`;
  const hit = currencyCache.get(cacheKey);
  if (hit) return hit;
  const r = await call(cfg, "GET", "/account");
  const cur = r.ok ? String(r.body.default_currency ?? "").toLowerCase() : "";
  if (cur) currencyCache.set(cacheKey, cur);
  return cur || "usd";
}
/** Test helper: forget cached account currencies. */
export function resetStripeCurrency(): void { currencyCache.clear(); }

/* ---------------- the processor ---------------- */

const idem = (ctx: CheckRef, op: string) => `apos:${ctx.storeId}:${ctx.checkNo}:${ctx.tenderKey}:${op}`.replace(/[^A-Za-z0-9:_-]/g, "_");
const metadata = (ctx: CheckRef) => ({
  store_id: ctx.storeId, business_date_id: ctx.businessDateId, check_no: ctx.checkNo, check_key: ctx.checkKey,
  tender_key: ctx.tenderKey, terminal_pos_id: ctx.terminalPosId, employee_pos_id: ctx.employeePosId, revenue_center_id: ctx.revenueCenterId,
});
const EXPAND = { expand: ["latest_charge"] };

export function makeStripe(cfg: ProcessorConfig): CardProcessor {
  const ready = (): CardResult | null => {
    const key = stripeKey(cfg);
    if (!key) return failed("Stripe secret key is not set in the back office (Credit Card interface)");
    const mode = stripeKeyMode(key);
    if (mode && (mode === "test") !== cfg.testMode) return failed(`Stripe key is ${mode} mode but the store is in ${cfg.testMode ? "test" : "live"} mode`);
    return null;
  };

  const getIntent = (pi: string) => call(cfg, "GET", `/payment_intents/${encodeURIComponent(pi)}`, EXPAND);

  /** Decline / failure on an intent we started: cancel it so a retry on a new tender key starts clean. */
  const tidyFailed = async (pi: string) => { try { await call(cfg, "POST", `/payment_intents/${encodeURIComponent(pi)}/cancel`); } catch { /* best effort */ } };

  async function start(req: CardRequest, kind: "auth" | "sale"): Promise<CardResult> {
    const notReady = ready(); if (notReady) return notReady;
    const readerId = (req.readerId || stripeLocalReader()).trim();
    if (!readerId) return failed("No Stripe reader is assigned to this terminal (TyroTerminalID, or Functions → Card setup)");
    if (req.amount < 0.5) return failed("Stripe minimum charge is $0.50");

    const existing = Object.values(txns()).find((t) => t.tenderKey === req.tenderKey && t.checkNo === req.checkNo);
    if (existing) { const r = await getIntent(existing.pi); return r.ok ? intentResult(r.body) : replyFailure(r, existing.pi); }

    const tip = kind === "sale" ? round2(req.tip ?? 0) : 0;
    const total = round2(req.amount + tip);
    const currency = await stripeCurrency(cfg);
    // Debit (Interac, Canada) is a one-step charge made by the customer on the pinpad: counter service and
    // pay at table. A one-shot sale in CAD therefore accepts Interac as well as credit cards. A hold
    // (authorize) stays credit-only: Interac cannot be held, so Stripe declines it there, which is wanted.
    const types = kind === "sale" && currency.toLowerCase() === "cad" ? ["card_present", "interac_present"] : ["card_present"];
    const created = await call(cfg, "POST", "/payment_intents", {
      amount: cents(total), currency, payment_method_types: types,
      capture_method: kind === "auth" ? "manual" : "automatic",
      payment_method_options: { card_present: { request_incremental_authorization_support: kind === "auth" ? true : undefined, request_extended_authorization: kind === "auth" ? true : undefined } },
      description: `Check ${req.checkNo}`, metadata: metadata(req), ...EXPAND,
    }, idem(req, `create:${kind}`));
    if (!created.ok) return replyFailure(created);
    const pi = str(created.body.id) ?? "";
    if (!pi) return failed("Stripe returned no PaymentIntent id");

    // Hand off to the reader. The reader prompts for a tip only on a one-shot sale whose tender asks for it.
    const promptTip = kind === "sale" && !!req.promptTip && tip === 0;
    const handoff = await call(cfg, "POST", `/terminal/readers/${encodeURIComponent(readerId)}/process_payment_intent`, {
      payment_intent: pi,
      process_config: { skip_tipping: promptTip ? undefined : true, tipping: promptTip ? { amount_eligible: cents(req.amount) } : undefined, enable_customer_cancellation: true },
    }, idem(req, `process:${kind}`));
    if (!handoff.ok) { await tidyFailed(pi); return replyFailure(handoff, pi); }
    const reader = readerInfo(handoff.body);
    putTxn({ pi, kind, readerId, simulated: reader.simulated, presented: false, checkNo: req.checkNo, tenderKey: req.tenderKey, amount: req.amount, tip });

    // Simulated reader in test mode: present the test card the amount picks, so the flow runs end to end from the POS.
    if (reader.simulated && cfg.testMode) {
      const card = testCardFor(req.amount);
      if (card) { await presentTestCard(cfg, readerId, card); const t = getTxn(pi); if (t) putTxn({ ...t, presented: true }); }
    }
    return { status: "pending", message: "Present the card on the reader…", ref: pi, recordNo: pi };
  }

  return {
    name: "stripe",
    authorize: (req) => start(req, "auth"),
    sale: (req) => start(req, "sale"),

    async status(ref) {
      const notReady = ready(); if (notReady) return notReady;
      const r = await getIntent(ref);
      if (!r.ok) return replyFailure(r, ref);
      const result = intentResult(r.body);
      if (result.status !== "pending") {
        if (result.status === "declined" || result.status === "error") await tidyFailed(ref);
        return result;
      }
      // Still waiting on the card: did the reader action fail without the intent recording it (customer cancel, connection)?
      const t = getTxn(ref);
      if (t && str(r.body.status) === "requires_payment_method") {
        const rd = await getReader(cfg, t.readerId);
        if (rd.ok && rd.reader.actionStatus === "failed" && rd.reader.actionType === "process_payment_intent") {
          await tidyFailed(ref);
          const code = rd.reader.failureCode ?? "";
          if (code === "customer_canceled") return { status: "cancelled", message: "Cancelled on the reader", ref };
          if (code === "card_declined") return declined(`Declined — ${rd.reader.failureMessage ?? "card declined"}`, { ref });
          return failed(`Reader: ${rd.reader.failureMessage || code || "action failed"}`, { ref });
        }
      }
      return result;
    },

    /** Finalize: capture base + tip. A tip above the authorization rides on overcapture (US, eligible MCCs). */
    async capture(ref, amounts: CardAmounts, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const cur = await getIntent(ref);
      if (!cur.ok) return replyFailure(cur, ref);
      const pi = cur.body;
      const st = str(pi.status);
      if (st === "succeeded") return failed("Already captured");
      if (st === "canceled") return failed("Transaction was cancelled");
      if (st !== "requires_capture") return failed(`Not an open authorization (${st ?? "unknown"})`);
      const total = cents(round2(amounts.amount + amounts.tip));
      const authorized = numv(pi.amount) ?? total;
      if (total > authorized) {
        // A tip above the hold: overcapture where the card allows it (US, eligible MCCs), otherwise raise
        // the authorization first (Canadian accounts have no overcapture, seen 2026-11-06), else refuse.
        const { card } = chargeOf(pi);
        if (card.overcapture_supported === true) {
          const limit = authorized + Math.max(Math.round(authorized * 0.5), 5000);
          if (total > limit) return failed(`Total exceeds the overcapture limit (${(limit / 100).toFixed(2)})`);
        } else if (card.incremental_authorization_supported === true) {
          const inc = await call(cfg, "POST", `/payment_intents/${encodeURIComponent(ref)}/increment_authorization`, { amount: total }, idem(ctx, `capture-inc:${total}`));
          if (!inc.ok) return replyFailure(inc, ref);
        } else {
          return failed("The tip exceeds the authorization and this card allows neither overcapture nor an increase — capture without the tip or re-run the card");
        }
      }
      const r = await call(cfg, "POST", `/payment_intents/${encodeURIComponent(ref)}/capture`, { amount_to_capture: total, ...EXPAND }, idem(ctx, `capture:${total}`));
      if (!r.ok) return replyFailure(r, ref);
      return { ...intentResult(r.body), status: "ok", message: "Captured", tip: round2(amounts.tip), capturedAmount: round2(total / 100) };
    },

    /** After capture Stripe only goes down: a smaller total is a partial refund; a larger one needs a new payment. */
    async adjust(ref, amounts: CardAmounts, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const cur = await getIntent(ref);
      if (!cur.ok) return replyFailure(cur, ref);
      const pi = cur.body;
      const st = str(pi.status);
      if (st === "requires_capture") return failed("Not captured yet — finalize it with the new amounts instead");
      if (st !== "succeeded") return failed(`Not a captured payment (${st ?? "unknown"})`);
      const { charge } = chargeOf(pi);
      const capturedC = numv(charge.amount_captured) ?? numv(pi.amount) ?? 0;
      const refundedC = numv(charge.amount_refunded) ?? 0;
      const netC = capturedC - refundedC;
      const wantC = cents(round2(amounts.amount + amounts.tip));
      const base = intentResult(pi);
      if (wantC > netC) return failed("A captured Stripe payment cannot be increased — take a second payment for the difference");
      if (wantC === netC) return { ...base, status: "ok", message: "No change", tip: round2(amounts.tip), capturedAmount: round2(netC / 100) };
      if (isInterac(pi)) return needsPresent(ref, netC - wantC);
      const r = await call(cfg, "POST", "/refunds", { payment_intent: ref, amount: netC - wantC, metadata: metadata(ctx) }, idem(ctx, `adjust:${wantC}`));
      if (!r.ok) return refusedInPerson(r) ? needsPresent(ref, netC - wantC) : replyFailure(r, ref);
      return { ...base, status: "ok", message: "Adjusted", tip: round2(amounts.tip), capturedAmount: round2(wantC / 100) };
    },

    /** Bar tab: raise the open authorization to the new total. */
    async increment(ref, newAmount, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const cur = await getIntent(ref);
      if (!cur.ok) return replyFailure(cur, ref);
      const pi = cur.body;
      if (str(pi.status) !== "requires_capture") return failed("Not an open authorization");
      const newC = cents(newAmount);
      if (newC <= (numv(pi.amount) ?? 0)) return failed("New amount must be higher than the authorization");
      const { card } = chargeOf(pi);
      if (card.incremental_authorization_supported === false) return failed("This card does not support incremental authorization — close the tab and start a new one");
      const r = await call(cfg, "POST", `/payment_intents/${encodeURIComponent(ref)}/increment_authorization`, { amount: newC, ...EXPAND }, idem(ctx, `inc:${newC}`));
      if (!r.ok) return replyFailure(r, ref);
      const res = intentResult(r.body);
      return { ...res, status: "ok", message: "Authorization increased", authorizedAmount: round2(newC / 100) };
    },

    /** Reader in progress → cancel_action; uncaptured → cancel the intent; captured → refund (full, or `amount`). */
    async cancel(ref, ctx, amount) {
      const notReady = ready(); if (notReady) return notReady;
      const t = getTxn(ref);
      const cur = await getIntent(ref);
      if (!cur.ok) return replyFailure(cur, ref);
      const pi = cur.body;
      const st = str(pi.status) ?? "";
      const base = intentResult(pi);
      if (st === "canceled") return { ...base, status: "cancelled", message: "Already cancelled" };
      if (st === "succeeded") {
        const { charge } = chargeOf(pi);
        const netC = (numv(charge.amount_captured) ?? numv(pi.amount) ?? 0) - (numv(charge.amount_refunded) ?? 0);
        const amt = amount !== undefined ? Math.min(cents(amount), netC) : netC;
        if (amt <= 0) return failed("Nothing left to refund");
        if (isInterac(pi)) return needsPresent(ref, amt);
        const r = await call(cfg, "POST", "/refunds", { payment_intent: ref, amount: amt, metadata: metadata(ctx) }, idem(ctx, `void:${amt}`));
        if (!r.ok) return refusedInPerson(r) ? needsPresent(ref, amt) : replyFailure(r, ref);
        const partial = amt < netC;
        return partial
          ? { ...base, status: "ok", message: "Partially refunded", capturedAmount: round2((netC - amt) / 100) }
          : { ...base, status: "cancelled", message: "Refunded (captured payments cannot be voided)", capturedAmount: 0 };
      }
      if (amount !== undefined && st === "requires_capture" && cents(amount) < (numv(pi.amount) ?? 0)) {
        return failed("An authorization cannot be reduced — capture the smaller amount at finalize");
      }
      if (st === "requires_payment_method" || st === "requires_confirmation") {
        if (t) { try { await call(cfg, "POST", `/terminal/readers/${encodeURIComponent(t.readerId)}/cancel_action`); } catch { /* reader may already be idle */ } }
      }
      const r = await call(cfg, "POST", `/payment_intents/${encodeURIComponent(ref)}/cancel`, { cancellation_reason: "requested_by_customer", ...EXPAND }, idem(ctx, "cancel"));
      if (!r.ok) {
        // The reader may be mid-authorization (terminal_reader_busy) — report the live state instead of a hard error.
        if (r.error?.code === "payment_intent_unexpected_state") { const again = await getIntent(ref); if (again.ok) return intentResult(again.body); }
        return replyFailure(r, ref);
      }
      return { ...intentResult(r.body), status: "cancelled", message: "Cancelled" };
    },

    /** Money back after capture. The refund's id becomes the new line's reference. */
    async refund(ref, amount, ctx) {
      const notReady = ready(); if (notReady) return notReady;
      const cur = await getIntent(ref);
      if (!cur.ok) return replyFailure(cur, ref);
      if (str(cur.body.status) !== "succeeded") return failed("Not captured — void it instead");
      const amt = cents(amount);
      if (isInterac(cur.body)) return needsPresent(ref, amt);
      const r = await call(cfg, "POST", "/refunds", { payment_intent: ref, amount: amt, metadata: metadata(ctx) }, idem(ctx, `refund:${amt}`));
      if (!r.ok) return refusedInPerson(r) ? needsPresent(ref, amt) : replyFailure(r, ref);
      const base = intentResult(cur.body);
      const refundId = str(r.body.id) ?? `${ref}R`;
      return { ...base, status: "ok", message: str(r.body.status) === "pending" ? "Refund pending" : "Refunded", ref: refundId, recordNo: refundId, capturedAmount: round2(amt / 100) };
    },

    /** Card-present refund (Terminal refund_payment): the reader asks for the card that made the payment.
     *  Mandatory for Interac; also the fallback when Stripe refuses a refund through the API. */
    presentRefund: {
      async start(ref, amount, ctx, readerId) {
        const notReady = ready(); if (notReady) return notReady;
        const rid = (readerId || getTxn(ref)?.readerId || stripeLocalReader()).trim();
        if (!rid) return failed("No Stripe reader is assigned to this terminal — a card-present refund needs one", { ref });
        const amt = cents(amount);
        if (amt <= 0) return failed("Nothing to refund", { ref });
        const r = await call(cfg, "POST", `/terminal/readers/${encodeURIComponent(rid)}/refund_payment`, { payment_intent: ref, amount: amt, metadata: metadata(ctx) });
        if (!r.ok) return replyFailure(r, ref);
        presentRefunds.set(ref, { readerId: rid });
        // Simulated reader in test mode: present the card so the flow runs end to end from the POS.
        if (readerInfo(r.body).simulated && cfg.testMode) {
          const pi = await getIntent(ref);
          await call(cfg, "POST", `/test_helpers/terminal/readers/${encodeURIComponent(rid)}/present_payment_method`, { type: pi.ok && isInterac(pi.body) ? "interac_present" : "card_present" });
        }
        return { status: "pending", message: `Present the same card on the reader to refund $${round2(amount).toFixed(2)}`, ref };
      },
      async status(ref) {
        const rec = presentRefunds.get(ref);
        if (!rec) return failed("No card-present refund is in progress", { ref });
        const rd = await getReader(cfg, rec.readerId);
        if (!rd.ok) return failed(`Stripe: ${rd.message}`, { ref });
        const a = rd.reader;
        if (a.actionType !== "refund_payment") return failed("The reader is not processing the refund", { ref });
        if (a.actionStatus === "in_progress") return { status: "pending", message: "Present the same card on the reader…", ref };
        presentRefunds.delete(ref);
        if (a.actionStatus === "succeeded") return { status: "ok", message: "Refunded on the reader", ref };
        if (a.failureCode === "customer_canceled") return { status: "cancelled", message: "Cancelled on the reader", ref };
        return failed(`Reader: ${a.failureMessage || a.failureCode || "refund failed"}`, { ref });
      },
      async abort(ref) {
        const rec = presentRefunds.get(ref);
        presentRefunds.delete(ref);
        if (rec) await call(cfg, "POST", `/terminal/readers/${encodeURIComponent(rec.readerId)}/cancel_action`);
      },
    },
  };
}

registerProcessor("stripe", makeStripe);
