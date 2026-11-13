/*
 * Stripe through the Terminal SDK (Android plugin) behind the card-processor seam.
 *
 * Why a second Stripe driver: the server-driven REST path (stripe.ts) needs the
 * internet for every card; the SDK stores a payment on the reader when the network
 * is down and forwards it later, and on the Stripe S710 it is the reader itself
 * (handoff mode). Everything that happens at the reader goes through the SDK here:
 * connect, collect and confirm, a card-present refund. Everything server-side —
 * capture at finalize, tip adjust, incremental auth, API refunds, status after the
 * fact — is delegated to the REST driver, with the same bundle credentials. One
 * processor name ("stripe"): the transport setting (transport.ts) picks this
 * driver or the REST one at selection time.
 *
 * References: online, the intent's Stripe id is the seam's `ref` from the first
 * reply, as with REST. Offline, the SDK has no id yet, so `ref` is a local
 * "off_…" id stamped into the intent's metadata; when the SDK forwards the payment
 * the local record learns the real id and every later call resolves through it.
 * Capture of an offline hold waits for forwarding (Stripe: capture after
 * onPaymentIntentForwarded), so finalize reports it as still pending.
 *
 * Test mode on a simulated reader: the amount's cents steer the simulated card,
 * the same codes as the REST driver (.99 declined .98 processing error .97
 * insufficient funds .95 Amex .94 Mastercard).
 */

import { loadJSON, saveJSON } from "@/platform/storage";
import { hasStripeTerminal, installTokenProvider, onTerminalEvent, pluginError, stripeTerminal, type CardSummary, type IntentSummary, type PluginError, type ReceiptSummary } from "@/platform/stripeterminal";
import type { ProcessorConfig } from "./config";
import { brandFromText, declined, failed, type CardAmounts, type CardProcessor, type CardRequest, type CardResult, type CheckRef } from "./processor";
import { cents, createConnectionToken, getReader, makeStripe, setStripeLocalReader, stripeCurrency, stripeKey, stripeKeyMode, stripeLocalReader, stripeLocation } from "./stripe";

const TXNS = "payments.stripe.sdk.txns.v1";   // { [ref]: SdkTxn }

interface SdkTxn {
  ref: string;              // the seam's reference: the Stripe id, or "off_…" while offline
  localId: string;          // the plugin's handle on the SDK PaymentIntent
  pi?: string;              // the Stripe id once known
  chargeId?: string;
  kind: "auth" | "sale";
  checkNo: string; tenderKey: string;
  amount: number; tip: number;
  offline: boolean;         // collected while offline; capture waits for forwarding
  forwarded: boolean;
}
function txns(): Record<string, SdkTxn> { return loadJSON<Record<string, SdkTxn>>(TXNS, {}); }
function putTxn(t: SdkTxn): void { const all = txns(); all[t.ref] = t; saveJSON(TXNS, all); }
function getTxn(ref: string): SdkTxn | undefined { return txns()[ref]; }
/** Test/dev helper. */
export function resetStripeSdk(): void { saveJSON(TXNS, {}); inflight.clear(); session.connected = false; }

const round2 = (n: number) => Math.round(n * 100) / 100;
const dollars = (c: number | null | undefined): number | undefined => (typeof c === "number" ? round2(c / 100) : undefined);

/* ---------------- result mapping (SDK intent → seam) ---------------- */

export function sdkReceiptLines(card: CardSummary | undefined): string | undefined {
  if (!card) return undefined;
  const r: ReceiptSummary = card.receipt ?? {};
  const known = (v: string | null | undefined) => (v && v.trim().toLowerCase() !== "unknown" ? v : undefined);
  const lines: string[] = [];
  const account = known(r.accountType) ?? known(card.funding);
  if (account) lines.push(`Account: ${account}`);
  if (r.applicationPreferredName) lines.push(`APN: ${r.applicationPreferredName}`);
  if (r.dedicatedFileName) lines.push(`AID: ${r.dedicatedFileName}`);
  if (r.terminalVerificationResults) lines.push(`TVR: ${r.terminalVerificationResults}`);
  if (r.transactionStatusInformation) lines.push(`TSI: ${r.transactionStatusInformation}`);
  if (r.applicationCryptogram) lines.push(`Cryptogram: ${r.applicationCryptogram}`);
  if (card.readMethod) lines.push(`ENTRY: ${card.readMethod.replace(/_/g, " ")}`);
  return lines.length ? lines.join("\n") : undefined;
}

/** The seam's view of an SDK intent. `ref` is what the check line will carry. */
export function sdkIntentResult(pi: IntentSummary, ref: string): CardResult {
  const charge = pi.charge;
  const card = charge?.card ?? pi.offline?.card;
  const interac = charge?.type === "interac_present";
  const base: Partial<CardResult> = {
    ref, recordNo: charge?.id ?? pi.id ?? ref,
    authCode: charge?.authorizationCode ?? card?.receipt?.authorizationCode ?? undefined,
    last4: card?.last4 ?? undefined,
    brand: card ? (interac ? "INTERAC" : brandFromText(card.brand ?? card.network ?? undefined)) : undefined,
    authorizedAmount: dollars(pi.amount),
    capturedAmount: charge?.captured ? dollars(charge.amount) : undefined,
    tip: dollars(pi.tipAmount ?? pi.amountTip),
  };
  const emv = sdkReceiptLines(card);
  if (emv) base.receipt = { customer: emv, merchant: emv };
  const st = pi.status ?? "";
  if (st === "CANCELED") return { status: "cancelled", message: "Cancelled", ...base };
  if (st === "SUCCEEDED") return { status: "ok", message: pi.offline?.requiresUpload ? "Approved (stored offline)" : "Approved", ...base };
  if (st === "REQUIRES_CAPTURE") return { status: "ok", message: pi.offline?.requiresUpload ? "Authorized (stored offline)" : "Authorized", ...base };
  if (pi.lastPaymentError && (pi.lastPaymentError.message || pi.lastPaymentError.code)) {
    const e = pi.lastPaymentError;
    const msg = e.message || e.code || "declined";
    return e.type === "card_error" || e.declineCode ? declined(`Declined — ${e.declineCode ? `${e.declineCode.replace(/_/g, " ")}: ` : ""}${msg}`, base) : failed(`Stripe: ${msg}`, base);
  }
  if (st === "PROCESSING") return { status: "pending", message: "Processing…", ...base };
  return { status: "pending", message: "Present the card on the reader…", ...base };
}

/** A rejected collect/confirm → seam result. */
export function sdkFailure(err: PluginError, ref: string): CardResult {
  const extra: Partial<CardResult> = { ref };
  if (err.cancelled) return { status: "cancelled", message: err.code === "CANCELED_BY_READER" ? "Cancelled on the reader" : "Cancelled", ...extra };
  const api = err.apiError;
  if (err.declined || api?.declineCode) {
    const dc = api?.declineCode ?? "";
    return declined(`Declined — ${dc ? `${dc.replace(/_/g, " ")}: ` : ""}${api?.message || err.message || "card declined"}`, extra);
  }
  return failed(`Reader: ${err.message || err.code || "payment failed"}`, extra);
}

/** The simulated card the amount's cents pick (same codes as the REST driver). */
export function simulatedCardFor(amount: number): { cardType?: string; number?: string } | null {
  switch (Math.round(amount * 100) % 100) {
    case 99: return { cardType: "CHARGE_DECLINED" };
    case 98: return { cardType: "CHARGE_DECLINED_PROCESSING_ERROR" };
    case 97: return { cardType: "CHARGE_DECLINED_INSUFFICIENT_FUNDS" };
    case 96: return null;                       // never presented: the REST driver's "stays pending"; the SDK simulator always presents, so the card is left as is
    case 95: return { cardType: "AMEX" };
    case 94: return { cardType: "MASTERCARD" };
    default: return { cardType: "VISA" };
  }
}

/* ---------------- session (one SDK, one reader) ---------------- */

const session = { inited: false, connected: false, listening: false, handoff: false, readerId: "", simulated: false };
/** Collect/confirm in flight by ref: the settled result once it lands. */
const inflight = new Map<string, { done: boolean; result?: CardResult; localId: string }>();

export function makeStripeSdk(cfg: ProcessorConfig): CardProcessor {
  const rest = makeStripe(cfg);   // server-side operations and status after the fact

  const ready = (): CardResult | null => {
    if (!hasStripeTerminal()) return failed("Stripe Terminal SDK is not available on this device");
    const key = stripeKey(cfg);
    if (!key) return failed("Stripe secret key is not set in the back office (Credit Card interface)");
    const mode = stripeKeyMode(key);
    if (mode && (mode === "test") !== cfg.testMode) return failed(`Stripe key is ${mode} mode but the store is in ${cfg.testMode ? "test" : "live"} mode`);
    return null;
  };

  /** Initialise the SDK once, with the token provider and the forwarding listener. */
  async function ensureInit(): Promise<void> {
    const p = stripeTerminal();
    if (!session.inited) {
      await installTokenProvider(() => createConnectionToken(cfg));
      const st = await p.init({ verbose: false });
      if (!st.locationGranted) {
        const g = await p.requestLocation();
        if (!g.granted) throw new Error("Location permission is required for card payments (Stripe)");
      }
      session.inited = true;
    }
    if (!session.listening) {
      session.listening = true;
      await onTerminalEvent<IntentSummary>("paymentIntentForwarded", (pi) => {
        // An offline payment reached Stripe: the local record learns its id.
        const all = txns();
        const t = Object.values(all).find((x) => (pi.localId && x.localId === pi.localId) || (pi.metadata?.tender_key && x.tenderKey === pi.metadata.tender_key && x.checkNo === pi.metadata.check_no));
        if (t) { t.pi = pi.id ?? t.pi; t.chargeId = pi.charge?.id ?? t.chargeId; t.forwarded = !pi.error && !!pi.id; putTxn(t); }
      });
      await onTerminalEvent("readerDisconnect", () => { session.connected = false; });
    }
  }

  /** Connect to the reader: handoff on the S710, otherwise the terminal's reader over the LAN. */
  async function ensureConnected(readerId: string): Promise<void> {
    const p = stripeTerminal();
    if (session.connected && session.readerId === readerId) {
      const st = await p.status();
      if (st.connectionStatus === "CONNECTED") return;
      session.connected = false;
    }
    // Test mode: when the terminal's reader is the REST-created simulated reader (or there is none), the SDK's
    // own simulated reader stands in — found with isSimulated discovery, no id filter (it is not that tmr_ object).
    let simulated = false;
    if (cfg.testMode) {
      if (!readerId) simulated = true;
      else { const rd = await getReader(cfg, readerId).catch(() => null); simulated = !!rd && rd.ok && rd.reader.simulated; }
    }
    const r = await p.connect({ mode: "auto", locationId: stripeLocation(cfg), readerId: simulated ? "" : readerId, simulated, failIfInUse: false });
    session.connected = true; session.handoff = !!r.handoff; session.readerId = readerId; session.simulated = simulated || !!r.simulated;
    // On the S710 the app IS the reader: handoff discovery names it, so remember its tmr_ id as this terminal's reader.
    // Nobody pairs a reader with itself, yet the REST fallback and a card-present refund still address it by id.
    if (r.handoff && r.id && !r.simulated && r.id !== readerId) setStripeLocalReader(r.id);
  }

  /** The Stripe id behind a seam reference (an offline ref resolves once forwarded). */
  const resolveId = (ref: string): string | undefined => (ref.startsWith("off_") ? getTxn(ref)?.pi : ref);
  const notForwarded = (ref: string): CardResult => ({ status: "pending", message: "Stored offline — waiting for the connection to forward it to Stripe", ref });

  async function start(req: CardRequest, kind: "auth" | "sale"): Promise<CardResult> {
    const notReady = ready(); if (notReady) return notReady;
    if (req.amount < 0.5) return failed("Stripe minimum charge is $0.50");
    const existing = Object.values(txns()).find((t) => t.tenderKey === req.tenderKey && t.checkNo === req.checkNo);
    if (existing) return status(existing.ref, req);

    const readerId = (req.readerId || stripeLocalReader()).trim();
    try { await ensureInit(); await ensureConnected(readerId); }
    catch (e) { return failed(`Reader: ${(e as Error).message ?? String(e)}`); }

    const p = stripeTerminal();
    const tip = kind === "sale" ? round2(req.tip ?? 0) : 0;
    const total = round2(req.amount + tip);
    let currency = "usd";
    try { currency = await stripeCurrency(cfg); } catch { /* offline: the REST lookup fails; the bundle currency or the cached one applies */ }
    const types: Array<"card_present" | "interac_present" | "card"> = req.deviceKeyedEntry ? ["card"]
      : kind === "sale" && currency.toLowerCase() === "cad" ? ["card_present", "interac_present"] : ["card_present"];
    const localRef = `off_${req.tenderKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const metadata = {
      store_id: req.storeId, business_date_id: req.businessDateId, check_no: req.checkNo, check_key: req.checkKey,
      tender_key: req.tenderKey, terminal_pos_id: req.terminalPosId, employee_pos_id: req.employeePosId, revenue_center_id: req.revenueCenterId, local_ref: localRef,
    };

    let created: IntentSummary;
    try {
      created = await p.createPaymentIntent({
        amount: cents(total), currency, captureMethod: kind === "auth" ? "manual" : "automatic", paymentMethodTypes: types,
        extendedAuth: kind === "auth", incrementalAuth: kind === "auth", description: `Check ${req.checkNo}`, metadata, offlineBehavior: "prefer_online",
      });
    } catch (e) { return sdkFailure(pluginError(e), ""); }
    const localId = created.localId ?? "";
    const offline = !created.id;
    const ref = created.id ?? localRef;
    putTxn({ ref, localId, pi: created.id ?? undefined, kind, checkNo: req.checkNo, tenderKey: req.tenderKey, amount: req.amount, tip, offline, forwarded: !offline });

    if (cfg.testMode && session.simulated) {
      const sim = simulatedCardFor(req.amount);
      if (sim) { try { await p.setSimulatedCard(sim); } catch { /* simulator config refused: the default Visa stands */ } }
    }

    // The reader prompt runs in the background; the seam polls status() until it settles.
    const promptTip = kind === "sale" && !!req.promptTip && tip === 0;
    const slot = { done: false, localId, result: undefined as CardResult | undefined };
    inflight.set(ref, slot);
    p.collectAndConfirm({ localId, skipTipping: !promptTip, tipEligibleAmount: promptTip ? cents(req.amount) : undefined, moto: !!req.deviceKeyedEntry, customerCancel: true })
      .then((pi) => {
        const t = getTxn(ref);
        if (t) { t.pi = pi.id ?? t.pi; t.chargeId = pi.charge?.id ?? t.chargeId; t.offline = !!pi.offline?.requiresUpload; t.forwarded = !t.offline && !!pi.id; putTxn(t); }
        slot.result = sdkIntentResult(pi, ref); slot.done = true;
      })
      .catch((e) => { slot.result = sdkFailure(pluginError(e), ref); slot.done = true; });
    return { status: "pending", message: "Present the card on the reader…", ref, recordNo: ref };
  }

  async function status(ref: string, ctx: CheckRef): Promise<CardResult> {
    const slot = inflight.get(ref);
    if (slot) {
      if (!slot.done) return { status: "pending", message: "Present the card on the reader…", ref };
      const r = slot.result!;
      if (r.status !== "pending") inflight.delete(ref);
      return r;
    }
    const t = getTxn(ref);
    if (t && t.localId && (t.offline && !t.forwarded)) {
      // Still on the reader: the plugin's copy of the intent is the only truth.
      try { const pi = await stripeTerminal().getPaymentIntent({ localId: t.localId }); return sdkIntentResult(pi, ref); } catch { return notForwarded(ref); }
    }
    const id = resolveId(ref);
    if (!id) return notForwarded(ref);
    return rest.status(id, ctx);
  }

  const viaRest = (ref: string, fn: (id: string) => Promise<CardResult>): Promise<CardResult> => {
    const t = getTxn(ref);
    if (t?.offline && !t.forwarded) return Promise.resolve(notForwarded(ref));
    const id = resolveId(ref);
    return id ? fn(id) : Promise.resolve(failed("Unknown Stripe reference", { ref }));
  };

  let presentRef: { ref: string } | null = null;
  const refundSlots = new Map<string, { done: boolean; result?: CardResult }>();

  return {
    name: "stripe",
    authorize: (req) => start(req, "auth"),
    sale: (req) => start(req, "sale"),
    status,
    capture: (ref, amounts: CardAmounts, ctx) => viaRest(ref, (id) => rest.capture(id, amounts, ctx)),
    adjust: (ref, amounts: CardAmounts, ctx) => viaRest(ref, (id) => rest.adjust(id, amounts, ctx)),
    increment: (ref, newAmount, ctx) => viaRest(ref, (id) => rest.increment(id, newAmount, ctx)),
    refund: (ref, amount, ctx) => viaRest(ref, (id) => rest.refund(id, amount, ctx)),

    /** In the reader's hands → abort the prompt and cancel the intent; otherwise the server-side cancel. */
    async cancel(ref, ctx, amount) {
      const slot = inflight.get(ref);
      const t = getTxn(ref);
      if (slot && !slot.done) {
        const p = stripeTerminal();
        try { await p.cancelCollect({ localId: slot.localId }); } catch { /* may have just settled */ }
        try { await p.cancelPaymentIntent({ localId: slot.localId }); } catch { /* already cancelled or confirmed */ }
        inflight.delete(ref);
        return { status: "cancelled", message: "Cancelled", ref };
      }
      if (t?.offline && !t.forwarded) {
        // Nothing has reached Stripe yet: cancelling the local intent is the whole story.
        try { await stripeTerminal().cancelPaymentIntent({ localId: t.localId }); return { status: "cancelled", message: "Cancelled (offline payment discarded)", ref }; }
        catch (e) { return failed(`Reader: ${pluginError(e).message}`, { ref }); }
      }
      return viaRest(ref, (id) => rest.cancel(id, ctx, amount));
    },

    /** Card-present refund through the SDK: the connected reader asks for the card. */
    presentRefund: {
      async start(ref, amount, ctx, readerId) {
        const notReady = ready(); if (notReady) return notReady;
        const t = getTxn(ref);
        const id = resolveId(ref);
        if (!id) return notForwarded(ref);
        let chargeId = t?.chargeId;
        if (!chargeId) {
          const r = await rest.status(id, ctx);
          chargeId = r.recordNo && r.recordNo.startsWith("ch_") ? r.recordNo : undefined;
        }
        if (!chargeId) return failed("No charge to refund against", { ref });
        try { await ensureInit(); await ensureConnected((readerId || stripeLocalReader()).trim()); }
        catch (e) { return failed(`Reader: ${(e as Error).message ?? String(e)}`, { ref }); }
        let currency = "usd";
        try { currency = await stripeCurrency(cfg); } catch { /* keep default */ }
        const slot = { done: false, result: undefined as CardResult | undefined };
        refundSlots.set(ref, slot); presentRef = { ref };
        stripeTerminal().processRefund({ chargeId, amount: cents(amount), currency, customerCancel: true })
          .then((r) => {
            slot.done = true;
            const okStatus = (r.status ?? "").toLowerCase();
            slot.result = okStatus === "failed" ? failed(`Refund failed: ${r.failureReason ?? "unknown"}`, { ref })
              : { status: "ok", message: "Refunded on the reader", ref, capturedAmount: round2(amount) };
          })
          .catch((e) => { slot.done = true; const err = pluginError(e); slot.result = err.cancelled ? { status: "cancelled", message: "Cancelled on the reader", ref } : failed(`Reader: ${err.message}`, { ref }); });
        return { status: "pending", message: `Present the same card on the reader to refund $${round2(amount).toFixed(2)}`, ref };
      },
      async status(ref) {
        const slot = refundSlots.get(ref);
        if (!slot) return failed("No card-present refund is in progress", { ref });
        if (!slot.done) return { status: "pending", message: "Present the same card on the reader…", ref };
        refundSlots.delete(ref); presentRef = null;
        return slot.result!;
      },
      async abort(ref) {
        refundSlots.delete(ref);
        if (presentRef?.ref === ref) { presentRef = null; try { await stripeTerminal().cancelRefund(); } catch { /* idle */ } }
      },
    },
  };
}
