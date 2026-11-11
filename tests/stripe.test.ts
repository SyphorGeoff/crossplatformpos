// @vitest-environment jsdom
/*
 * Stripe (server-driven Terminal) driver — request encoding, headers
 * (Authorization, Stripe-Version, Idempotency-Key, Stripe-Account), the
 * PaymentIntent → CardResult mapping, and every seam operation mapped onto
 * payment_intents / terminal readers / refunds. The HTTP seam is mocked with
 * replies shaped like the Stripe API reference.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessorConfig } from "@/payments/config";
import type { CardRequest, CheckRef } from "@/payments/processor";
import { selectProcessor } from "@/payments/select";
import {
  cents, encodeForm, intentResult, makeStripe, receiptLines, resetStripe, setStripeLocalReader, STRIPE_API, STRIPE_VERSION, stripeKeyMode, testCardFor,
} from "@/payments/stripe";
import type { StoreConfig } from "@/model/catalog";

interface Call { url: string; method: string; headers: Record<string, string>; body: string; }
const calls: Call[] = [];
let replies: Array<{ status?: number; body: unknown }> = [];
vi.mock("@/platform/http", () => ({
  httpRequest: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" });
    const r = replies.shift() ?? { status: 200, body: {} };
    const status = r.status ?? 200;
    const text = JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, bytes: async () => new ArrayBuffer(0) };
  }),
}));

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  } as Storage;
}

const TEST_KEY = "rk_test_51FAKEFAKEFAKEFAKEFAKEFAKE";
const cfg = (over: Partial<ProcessorConfig> = {}): ProcessorConfig => ({
  name: "stripe", merchantId: "", bundle: { locationId: "tml_TEST1", secretKey: TEST_KEY, testMode: true, currency: "usd" }, testMode: true, timeoutSec: 60, ...over,
});
const ctx: CheckRef = { storeId: "3", businessDateId: "90042", checkNo: "280001", checkKey: "1234567", tenderKey: "7654321", terminalPosId: "28", employeePosId: "5", revenueCenterId: "1" };
const req = (amount: number, over: Partial<CardRequest> = {}): CardRequest => ({ ...ctx, amount, tenderId: "16", timeoutSec: 10, readerId: "tmr_SIM1", ...over });

const params = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));
const path = (c: Call) => c.url.replace(STRIPE_API, "").split("?")[0];

/* ---- Stripe-shaped fixtures ---- */
const charge = (over: Record<string, unknown> = {}, card: Record<string, unknown> = {}) => ({
  id: "ch_1", object: "charge", captured: false, amount: 2000, amount_captured: 0, amount_refunded: 0,
  payment_method_details: { type: "card_present", card_present: {
    brand: "visa", last4: "4242", amount_authorized: 2000, overcapture_supported: true, incremental_authorization_supported: true, read_method: "contact_emv",
    receipt: { authorization_code: "123456", application_preferred_name: "VISA CREDIT", dedicated_file_name: "A0000000031010", account_type: "credit", terminal_verification_results: "0000008000", transaction_status_information: "E800", application_cryptogram: "ABCDEF0123456789", cardholder_verification_method: "none" },
    ...card,
  } }, ...over,
});
const intent = (status: string, over: Record<string, unknown> = {}) => ({
  id: "pi_1", object: "payment_intent", status, amount: 2000, amount_details: { tip: {} }, capture_method: "manual", latest_charge: null, last_payment_error: null, ...over,
});
const reader = (action: Record<string, unknown> | null = null, deviceType = "simulated_wisepos_e") => ({ id: "tmr_SIM1", object: "terminal.reader", device_type: deviceType, label: "Sim", status: "online", action });

beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); resetStripe(); calls.length = 0; replies = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("encoding and helpers", () => {
  it("encodeForm nests objects with brackets, arrays with [], skips undefined", () => {
    expect(encodeForm({ amount: 2000, expand: ["latest_charge"], a: { b: { c: true }, skip: undefined }, n: null }))
      .toBe("amount=2000&expand%5B%5D=latest_charge&a%5Bb%5D%5Bc%5D=true");
  });
  it("cents rounds dollars to integer cents", () => { expect(cents(11.13)).toBe(1113); expect(cents(0.1 + 0.2)).toBe(30); expect(cents(19.999)).toBe(2000); });
  it("key mode comes from the prefix", () => {
    expect(stripeKeyMode("sk_test_abc")).toBe("test"); expect(stripeKeyMode("rk_live_abc")).toBe("live"); expect(stripeKeyMode("pk_test_abc")).toBe("");
  });
  it("test card follows the amount's cents like the mock", () => {
    expect(testCardFor(10.99)).toBe("4000000000000002"); expect(testCardFor(10.98)).toBe("4000000000000119"); expect(testCardFor(10.97)).toBe("4000000000009995");
    expect(testCardFor(10.96)).toBeNull(); expect(testCardFor(10.95)).toBe("378282246310005"); expect(testCardFor(10.94)).toBe("5555555555554444"); expect(testCardFor(10)).toBe("4242424242424242");
  });
  it("receipt lines carry the EMV fields a slip prints", () => {
    const lines = receiptLines((charge().payment_method_details as { card_present: Record<string, unknown> }).card_present)!;
    expect(lines).toContain("AID A0000000031010"); expect(lines).toContain("ACCOUNT credit"); expect(lines).toContain("AUTH 123456"); expect(lines).toContain("TVR 0000008000"); expect(lines).toContain("ENTRY contact emv");
  });
});

describe("intent → CardResult", () => {
  it("requires_capture = authorized, with ids, auth code, last4, brand and amounts", () => {
    const r = intentResult(intent("requires_capture", { latest_charge: charge() }));
    expect(r.status).toBe("ok"); expect(r.message).toBe("Authorized"); expect(r.ref).toBe("pi_1"); expect(r.recordNo).toBe("ch_1");
    expect(r.authCode).toBe("123456"); expect(r.last4).toBe("4242"); expect(r.brand).toBe("VISA"); expect(r.authorizedAmount).toBe(20); expect(r.capturedAmount).toBeUndefined();
    expect(r.receipt?.customer).toContain("AUTH 123456");
  });
  it("an Interac (debit) charge: details come from interac_present and the brand is INTERAC", () => {
    const interac = { id: "ch_2", object: "charge", captured: true, amount: 632, amount_captured: 632, amount_refunded: 0,
      payment_method_details: { type: "interac_present", interac_present: {
        brand: "interac", network: "interac", last4: "1933", read_method: "contactless_emv",
        receipt: { authorization_code: "654321", application_preferred_name: "Interac", dedicated_file_name: "A0000002771010", account_type: "checking" },
      } } };
    const r = intentResult(intent("succeeded", { amount: 632, latest_charge: interac }));
    expect(r.status).toBe("ok"); expect(r.brand).toBe("INTERAC"); expect(r.last4).toBe("1933"); expect(r.authCode).toBe("654321");
    expect(r.capturedAmount).toBe(6.32); expect(r.recordNo).toBe("ch_2");
    expect(r.receipt?.customer).toContain("ACCOUNT checking"); expect(r.receipt?.customer).toContain("ENTRY contactless emv");
  });
  it("succeeded = captured amount, tip from amount_details", () => {
    const r = intentResult(intent("succeeded", { amount: 2300, amount_details: { tip: { amount: 300 } }, latest_charge: charge({ captured: true, amount: 2300, amount_captured: 2300 }) }));
    expect(r.status).toBe("ok"); expect(r.capturedAmount).toBe(23); expect(r.tip).toBe(3);
  });
  it("last_payment_error card_error = declined with the decline code", () => {
    const r = intentResult(intent("requires_payment_method", { last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }));
    expect(r.status).toBe("declined"); expect(r.message).toContain("insufficient funds");
  });
  it("waiting on the reader = pending; canceled = cancelled", () => {
    expect(intentResult(intent("requires_payment_method")).status).toBe("pending");
    expect(intentResult(intent("processing")).status).toBe("pending");
    expect(intentResult(intent("canceled")).status).toBe("cancelled");
  });
});

describe("readiness", () => {
  it("no secret key in the bundle → error, no HTTP", async () => {
    const r = await makeStripe(cfg({ bundle: { locationId: "tml_TEST1", testMode: true, currency: "usd" } })).authorize(req(20));
    expect(r.status).toBe("error"); expect(r.message).toMatch(/secret key is not set/); expect(calls.length).toBe(0);
  });
  it("live key against a test store → error", async () => {
    const r = await makeStripe(cfg({ bundle: { secretKey: "sk_live_abc", testMode: true, currency: "usd" } })).authorize(req(20));
    expect(r.status).toBe("error"); expect(r.message).toMatch(/live mode/);
  });
  it("no reader → error", async () => {
    const p = makeStripe(cfg());
    expect((await p.authorize(req(20, { readerId: undefined }))).message).toMatch(/No Stripe reader/);
    expect(calls.length).toBe(0);
  });
  it("the terminal-local reader stands in for an empty TyroTerminalID", async () => {
    setStripeLocalReader("tmr_LOCAL");
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }, "stripe_s700") }];
    const r = await makeStripe(cfg()).authorize(req(20, { readerId: undefined }));
    expect(r.status).toBe("pending"); expect(path(calls[1])).toBe("/terminal/readers/tmr_LOCAL/process_payment_intent");
  });
});

describe("authorize (table service)", () => {
  it("creates a manual-capture card_present intent, hands it to the reader, presents the simulated card", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader({ type: "process_payment_intent", status: "succeeded" }) }];
    const r = await makeStripe(cfg()).authorize(req(20));
    expect(r.status).toBe("pending"); expect(r.ref).toBe("pi_1");
    expect(calls.length).toBe(3);
    const create = calls[0];
    expect(create.method).toBe("POST"); expect(path(create)).toBe("/payment_intents");
    expect(create.headers.Authorization).toBe(`Bearer ${TEST_KEY}`); expect(create.headers["Stripe-Version"]).toBe(STRIPE_VERSION);
    expect(create.headers["Idempotency-Key"]).toBe("apos:3:280001:7654321:create:auth"); expect(create.headers["Stripe-Account"]).toBeUndefined();
    expect(create.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const p = params(create);
    expect(p.amount).toBe("2000"); expect(p.currency).toBe("usd"); expect(p["payment_method_types[]"]).toBe("card_present"); expect(p.capture_method).toBe("manual");
    expect(p["payment_method_options[card_present][request_incremental_authorization_support]"]).toBe("true");
    expect(p["payment_method_options[card_present][request_extended_authorization]"]).toBe("true");
    expect(p["metadata[check_no]"]).toBe("280001"); expect(p["metadata[tender_key]"]).toBe("7654321"); expect(p["metadata[store_id]"]).toBe("3"); expect(p["expand[]"]).toBe("latest_charge");
    const handoff = calls[1];
    expect(path(handoff)).toBe("/terminal/readers/tmr_SIM1/process_payment_intent");
    const h = params(handoff);
    expect(h.payment_intent).toBe("pi_1"); expect(h["process_config[skip_tipping]"]).toBe("true"); expect(h["process_config[enable_customer_cancellation]"]).toBe("true");
    expect(h["process_config[tipping][amount_eligible]"]).toBeUndefined();
    const present = calls[2];
    expect(path(present)).toBe("/test_helpers/terminal/readers/tmr_SIM1/present_payment_method");
    expect(params(present)).toEqual({ type: "card_present", "card_present[number]": "4242424242424242" });
  });
  it("a physical reader gets no simulated presentment; .96 on a simulated reader is never presented", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }, "stripe_s700") }];
    await makeStripe(cfg()).authorize(req(20));
    expect(calls.length).toBe(2);
    calls.length = 0;
    replies = [{ body: intent("requires_payment_method", { id: "pi_2" }) }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }];
    await makeStripe(cfg()).authorize(req(20.96, { tenderKey: "k2" }));
    expect(calls.length).toBe(2);
  });
  it("a declined .99 presents the decline card", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader() }];
    await makeStripe(cfg()).authorize(req(10.99));
    expect(params(calls[2])["card_present[number]"]).toBe("4000000000000002");
  });
  it("reader hand-off failure cancels the intent and reports the error", async () => {
    replies = [{ body: intent("requires_payment_method") }, { status: 400, body: { error: { type: "invalid_request_error", code: "terminal_reader_offline", message: "Reader is currently offline" } } }, { body: intent("canceled") }];
    const r = await makeStripe(cfg()).authorize(req(20));
    expect(r.status).toBe("error"); expect(r.message).toContain("offline");
    expect(path(calls[2])).toBe("/payment_intents/pi_1/cancel");
  });
  it("Stripe card_error on create → declined", async () => {
    replies = [{ status: 402, body: { error: { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." } } }];
    const r = await makeStripe(cfg()).authorize(req(20));
    expect(r.status).toBe("declined"); expect(r.message).toContain("generic decline");
  });
  it("is idempotent per tender line: a retry reads the existing intent instead of creating another", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader() }];
    await makeStripe(cfg()).authorize(req(20));
    calls.length = 0;
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    const r = await makeStripe(cfg()).authorize(req(20));
    expect(calls.length).toBe(1); expect(calls[0].method).toBe("GET"); expect(path(calls[0])).toBe("/payment_intents/pi_1");
    expect(r.status).toBe("ok"); expect(r.authorizedAmount).toBe(20);
  });
  it("Connect: an acct_ bundle id goes in the Stripe-Account header", async () => {
    const c = cfg({ bundle: { accountId: "acct_123", locationId: "tml_1", secretKey: TEST_KEY, testMode: true, currency: "usd" } });
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(c).authorize(req(20));
    expect(calls[0].headers["Stripe-Account"]).toBe("acct_123");
  });
});

describe("currency", () => {
  it("without a bundle currency the account's default_currency is read once and used (CA account → cad)", async () => {
    const c = cfg({ bundle: { locationId: "tml_TEST1", secretKey: TEST_KEY, testMode: true } });
    replies = [{ body: { id: "acct_ca", object: "account", default_currency: "cad" } }, { body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(c).authorize(req(20));
    expect(path(calls[0])).toBe("/account"); expect(calls[0].method).toBe("GET");
    expect(params(calls[1]).currency).toBe("cad");
    calls.length = 0;
    replies = [{ body: intent("requires_payment_method", { id: "pi_2" }) }, { body: reader(null, "stripe_s700") }];
    await makeStripe(c).authorize(req(20, { tenderKey: "k2" }));
    expect(path(calls[0])).toBe("/payment_intents");   // cached: no second /account call
    expect(params(calls[0]).currency).toBe("cad");
  });
  it("a bundle currency wins without any lookup", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cfg({ bundle: { secretKey: TEST_KEY, testMode: true, currency: "CAD" } })).authorize(req(20));
    expect(path(calls[0])).toBe("/payment_intents"); expect(params(calls[0]).currency).toBe("cad");
  });
});

describe("sale (one-shot)", () => {
  it("automatic capture; a tip taken on the POS is in the amount and the reader skips tipping", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cfg()).sale(req(20, { tip: 3, promptTip: true }));
    const p = params(calls[0]);
    expect(p.amount).toBe("2300"); expect(p.capture_method).toBe("automatic");
    expect(p["payment_method_options[card_present][request_incremental_authorization_support]"]).toBeUndefined();
    expect(params(calls[1])["process_config[skip_tipping]"]).toBe("true");
  });
  it("a CAD sale accepts Interac debit as well as credit; a USD sale and a CAD hold stay credit-only", async () => {
    const types = (c: Call) => new URLSearchParams(c.body).getAll("payment_method_types[]");
    const cad = () => cfg({ bundle: { locationId: "tml_TEST1", secretKey: TEST_KEY, testMode: true, currency: "cad" } });
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cad()).sale(req(20));
    expect(types(calls[0])).toEqual(["card_present", "interac_present"]);
    calls.length = 0; resetStripe();
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cfg()).sale(req(20));
    expect(types(calls[0])).toEqual(["card_present"]);
    calls.length = 0; resetStripe();
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cad()).authorize(req(20));
    expect(types(calls[0])).toEqual(["card_present"]);
  });
  it("promptTip without a POS tip lets the reader prompt, tip-eligible = the base amount", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cfg()).sale(req(20, { promptTip: true }));
    const h = params(calls[1]);
    expect(h["process_config[skip_tipping]"]).toBeUndefined(); expect(h["process_config[tipping][amount_eligible]"]).toBe("2000");
  });
});

describe("status (polling)", () => {
  it("authorized intent → ok", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    const r = await makeStripe(cfg()).status("pi_1", ctx);
    expect(r.status).toBe("ok"); expect(r.message).toBe("Authorized"); expect(path(calls[0])).toBe("/payment_intents/pi_1"); expect(calls[0].url).toContain("expand%5B%5D=latest_charge");
  });
  it("declined intent → declined, and the intent is cancelled so the next try starts clean", async () => {
    replies = [{ body: intent("requires_payment_method", { last_payment_error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds" } }) }, { body: intent("canceled") }];
    const r = await makeStripe(cfg()).status("pi_1", ctx);
    expect(r.status).toBe("declined"); expect(path(calls[1])).toBe("/payment_intents/pi_1/cancel");
  });
  it("still waiting with the reader action failed (customer cancelled) → cancelled", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader() }];
    await makeStripe(cfg()).authorize(req(20));
    calls.length = 0;
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "failed", failure_code: "customer_canceled", failure_message: "cancelled" }) }, { body: intent("canceled") }];
    const r = await makeStripe(cfg()).status("pi_1", ctx);
    expect(r.status).toBe("cancelled"); expect(path(calls[1])).toBe("/terminal/readers/tmr_SIM1");
  });
  it("still waiting, reader in progress → pending", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader() }];
    await makeStripe(cfg()).authorize(req(20));
    calls.length = 0;
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }];
    expect((await makeStripe(cfg()).status("pi_1", ctx)).status).toBe("pending");
  });
});

describe("capture (finalize)", () => {
  it("captures base + tip with amount_to_capture", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }, { body: intent("succeeded", { amount: 2300, latest_charge: charge({ captured: true, amount_captured: 2300 }) }) }];
    const r = await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 3 }, ctx);
    expect(r.status).toBe("ok"); expect(r.message).toBe("Captured"); expect(r.capturedAmount).toBe(23); expect(r.tip).toBe(3);
    expect(path(calls[1])).toBe("/payment_intents/pi_1/capture"); expect(params(calls[1]).amount_to_capture).toBe("2300");
    expect(calls[1].headers["Idempotency-Key"]).toBe("apos:3:280001:7654321:capture:2300");
  });
  it("a tip above the authorization without overcapture raises the authorization first (incremental), then captures", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge({}, { overcapture_supported: false }) }) }, { body: intent("requires_capture", { amount: 2300 }) }, { body: intent("succeeded", { amount: 2300, latest_charge: charge({ captured: true, amount_captured: 2300 }) }) }];
    const r = await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 3 }, ctx);
    expect(r.status).toBe("ok"); expect(r.capturedAmount).toBe(23);
    expect(path(calls[1])).toBe("/payment_intents/pi_1/increment_authorization"); expect(params(calls[1]).amount).toBe("2300");
    expect(path(calls[2])).toBe("/payment_intents/pi_1/capture"); expect(params(calls[2]).amount_to_capture).toBe("2300");
  });
  it("a tip above the authorization with neither overcapture nor incremental support is refused; overcapture stays inside its limit", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge({}, { overcapture_supported: false, incremental_authorization_supported: false }) }) }];
    expect((await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 3 }, ctx)).message).toMatch(/neither overcapture nor an increase/);
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    expect((await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 60 }, ctx)).message).toMatch(/overcapture limit/);   // $20 auth → max $70
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }, { body: intent("succeeded", { amount: 6900, latest_charge: charge({ captured: true, amount_captured: 6900 }) }) }];
    expect((await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 49 }, ctx)).status).toBe("ok");
  });
  it("already captured / cancelled → error", async () => {
    replies = [{ body: intent("succeeded", { latest_charge: charge({ captured: true }) }) }];
    expect((await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 0 }, ctx)).message).toBe("Already captured");
    replies = [{ body: intent("canceled") }];
    expect((await makeStripe(cfg()).capture("pi_1", { amount: 20, tip: 0 }, ctx)).message).toMatch(/cancelled/);
  });
});

describe("increment (bar tab)", () => {
  it("raises the open auth to the new total", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }, { body: intent("requires_capture", { amount: 3500, latest_charge: charge({}, { amount_authorized: 3500 }) }) }];
    const r = await makeStripe(cfg()).increment("pi_1", 35, ctx);
    expect(r.status).toBe("ok"); expect(r.authorizedAmount).toBe(35);
    expect(path(calls[1])).toBe("/payment_intents/pi_1/increment_authorization"); expect(params(calls[1]).amount).toBe("3500");
  });
  it("refuses a lower amount, a captured intent, and a card without incremental support", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    expect((await makeStripe(cfg()).increment("pi_1", 15, ctx)).message).toMatch(/higher/);
    replies = [{ body: intent("succeeded", { latest_charge: charge({ captured: true }) }) }];
    expect((await makeStripe(cfg()).increment("pi_1", 35, ctx)).message).toMatch(/Not an open authorization/);
    replies = [{ body: intent("requires_capture", { latest_charge: charge({}, { incremental_authorization_supported: false }) }) }];
    expect((await makeStripe(cfg()).increment("pi_1", 35, ctx)).message).toMatch(/does not support incremental/);
  });
});

describe("adjust (after capture)", () => {
  const captured = () => intent("succeeded", { amount: 2300, latest_charge: charge({ captured: true, amount: 2300, amount_captured: 2300 }) });
  it("a smaller total is a partial refund of the difference", async () => {
    replies = [{ body: captured() }, { body: { id: "re_1", object: "refund", status: "succeeded", amount: 200 } }];
    const r = await makeStripe(cfg()).adjust("pi_1", { amount: 20, tip: 1 }, ctx);
    expect(r.status).toBe("ok"); expect(r.capturedAmount).toBe(21);
    expect(path(calls[1])).toBe("/refunds"); expect(params(calls[1])).toMatchObject({ payment_intent: "pi_1", amount: "200" });
  });
  it("a larger total is refused; an equal one is a no-op; an uncaptured auth says finalize instead", async () => {
    replies = [{ body: captured() }];
    expect((await makeStripe(cfg()).adjust("pi_1", { amount: 20, tip: 5 }, ctx)).message).toMatch(/cannot be increased/);
    replies = [{ body: captured() }];
    expect((await makeStripe(cfg()).adjust("pi_1", { amount: 20, tip: 3 }, ctx)).message).toBe("No change");
    expect(calls.length).toBe(2);
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    expect((await makeStripe(cfg()).adjust("pi_1", { amount: 20, tip: 3 }, ctx)).message).toMatch(/finalize/);
  });
});

describe("cancel / refund (void path)", () => {
  it("an uncaptured auth is cancelled (reader action cancelled first while the card is being read)", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader({ type: "process_payment_intent", status: "in_progress" }) }, { body: reader() }];
    await makeStripe(cfg()).authorize(req(20));
    calls.length = 0;
    replies = [{ body: intent("requires_payment_method") }, { body: reader() }, { body: intent("canceled") }];
    const r = await makeStripe(cfg()).cancel("pi_1", ctx);
    expect(r.status).toBe("cancelled");
    expect(path(calls[1])).toBe("/terminal/readers/tmr_SIM1/cancel_action"); expect(path(calls[2])).toBe("/payment_intents/pi_1/cancel");
  });
  it("an authorized (requires_capture) intent is cancelled without touching the reader", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }, { body: intent("canceled", { latest_charge: charge() }) }];
    const r = await makeStripe(cfg()).cancel("pi_1", ctx);
    expect(r.status).toBe("cancelled"); expect(calls.length).toBe(2); expect(path(calls[1])).toBe("/payment_intents/pi_1/cancel");
  });
  it("a captured payment is refunded instead (no void after capture)", async () => {
    replies = [{ body: intent("succeeded", { amount: 2300, latest_charge: charge({ captured: true, amount: 2300, amount_captured: 2300 }) }) }, { body: { id: "re_1", status: "succeeded" } }];
    const r = await makeStripe(cfg()).cancel("pi_1", ctx);
    expect(r.status).toBe("cancelled"); expect(r.message).toMatch(/Refunded/);
    expect(path(calls[1])).toBe("/refunds"); expect(params(calls[1]).amount).toBe("2300");
  });
  it("a partial cancel of an open auth is refused (capture less at finalize)", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    expect((await makeStripe(cfg()).cancel("pi_1", ctx, 5)).message).toMatch(/cannot be reduced/);
  });
  it("refund: captured only; the refund id becomes the reference", async () => {
    replies = [{ body: intent("requires_capture", { latest_charge: charge() }) }];
    expect((await makeStripe(cfg()).refund("pi_1", 5, ctx)).message).toMatch(/Not captured/);
    replies = [{ body: intent("succeeded", { latest_charge: charge({ captured: true, amount_captured: 2000 }) }) }, { body: { id: "re_9", status: "succeeded" } }];
    const r = await makeStripe(cfg()).refund("pi_1", 5, ctx);
    expect(r.status).toBe("ok"); expect(r.ref).toBe("re_9"); expect(r.capturedAmount).toBe(5); expect(params(calls[2])).toMatchObject({ payment_intent: "pi_1", amount: "500" });
  });
});

describe("seam registration and secrets", () => {
  it("selectProcessor resolves a stripe store to this module", () => {
    const store = { ccProcessor: "stripe", ccTestMode: true, ccTimeoutSec: 60, merchantId: "", merchantBundle: `{"accountId":"","locationId":"tml_1","secretKey":"${TEST_KEY}","testMode":true}` } as unknown as StoreConfig;
    const sel = selectProcessor(store);
    expect(sel?.processor.name).toBe("stripe"); expect(sel?.config.bundle.secretKey).toBe(TEST_KEY);
  });
  it("the key is sent only as the Authorization header, never in a URL or body, and is not cached by the driver", async () => {
    replies = [{ body: intent("requires_payment_method") }, { body: reader(null, "stripe_s700") }];
    await makeStripe(cfg()).authorize(req(20));
    for (const c of calls) { expect(c.url).not.toContain(TEST_KEY); expect(c.body).not.toContain(TEST_KEY); expect(c.headers.Authorization).toBe(`Bearer ${TEST_KEY}`); }
    for (let i = 0; i < localStorage.length; i++) { expect(localStorage.getItem(localStorage.key(i)!)).not.toContain(TEST_KEY); }
  });
});

describe("card-present refund", () => {
  const interac = () => charge({ captured: true, amount_captured: 2000, payment_method_details: { type: "interac_present", interac_present: { last4: "1933" } } });
  it("an Interac payment is never refunded through the API: cancel, refund and adjust ask for the card instead", async () => {
    const p = makeStripe(cfg());
    replies = [{ body: intent("succeeded", { latest_charge: interac() }) }];
    const a = await p.cancel("pi_1", ctx);
    expect(a.status).toBe("error"); expect(a.needsCardPresent).toEqual({ amount: 20 });
    replies = [{ body: intent("succeeded", { latest_charge: interac() }) }];
    expect((await p.refund("pi_1", 5, ctx)).needsCardPresent).toEqual({ amount: 5 });
    replies = [{ body: intent("succeeded", { latest_charge: interac() }) }];
    expect((await p.adjust("pi_1", { amount: 15, tip: 2 }, ctx)).needsCardPresent).toEqual({ amount: 3 });
    expect(calls.map(path)).toEqual(["/payment_intents/pi_1", "/payment_intents/pi_1", "/payment_intents/pi_1"]);   // no /refunds call
  });
  it("an API refund Stripe refuses as in-person asks for the card the same way", async () => {
    replies = [{ body: intent("succeeded", { latest_charge: charge({ captured: true, amount_captured: 2000 }) }) },
      { status: 400, body: { error: { type: "invalid_request_error", message: "This payment must be refunded in person with the card present." } } }];
    const r = await makeStripe(cfg()).refund("pi_1", 8, ctx);
    expect(r.status).toBe("error"); expect(r.needsCardPresent).toEqual({ amount: 8 });
  });
  it("any other refund failure is a plain error", async () => {
    replies = [{ body: intent("succeeded", { latest_charge: charge({ captured: true, amount_captured: 2000 }) }) },
      { status: 400, body: { error: { type: "invalid_request_error", message: "Refund amount exceeds the charge" } } }];
    const r = await makeStripe(cfg()).refund("pi_1", 8, ctx);
    expect(r.status).toBe("error"); expect(r.needsCardPresent).toBeUndefined();
  });
  it("start hands the refund to the reader; status follows the reader action; a settled action is forgotten", async () => {
    const pr = makeStripe(cfg()).presentRefund!;
    replies = [{ body: reader({ type: "refund_payment", status: "in_progress" }, "stripe_s710") }];
    const s = await pr.start("pi_1", 5, ctx, "tmr_SIM1");
    expect(s.status).toBe("pending"); expect(s.message).toMatch(/\$5\.00/);
    expect(path(calls[0])).toBe("/terminal/readers/tmr_SIM1/refund_payment");
    expect(params(calls[0]).payment_intent).toBe("pi_1"); expect(params(calls[0]).amount).toBe("500");
    expect(calls).toHaveLength(1);                                               // a physical reader: no test-helper call
    replies = [{ body: reader({ type: "refund_payment", status: "in_progress" }, "stripe_s710") }];
    expect((await pr.status("pi_1", ctx)).status).toBe("pending");
    replies = [{ body: reader({ type: "refund_payment", status: "succeeded" }, "stripe_s710") }];
    expect(await pr.status("pi_1", ctx)).toMatchObject({ status: "ok", message: "Refunded on the reader" });
    expect((await pr.status("pi_1", ctx)).status).toBe("error");                 // nothing in progress any more
  });
  it("a cancel on the reader, a failure, and a reader doing something else are reported as such", async () => {
    const pr = makeStripe(cfg()).presentRefund!;
    const begin = async () => { replies = [{ body: reader({ type: "refund_payment", status: "in_progress" }, "stripe_s710") }]; await pr.start("pi_1", 5, ctx, "tmr_SIM1"); };
    await begin();
    replies = [{ body: reader({ type: "refund_payment", status: "failed", failure_code: "customer_canceled" }, "stripe_s710") }];
    expect((await pr.status("pi_1", ctx)).status).toBe("cancelled");
    await begin();
    replies = [{ body: reader({ type: "refund_payment", status: "failed", failure_code: "card_mismatch", failure_message: "The card does not match the original payment" }, "stripe_s710") }];
    expect(await pr.status("pi_1", ctx)).toMatchObject({ status: "error", message: "Reader: The card does not match the original payment" });
    await begin();
    replies = [{ body: reader({ type: "process_payment_intent", status: "in_progress" }, "stripe_s710") }];
    expect((await pr.status("pi_1", ctx)).message).toMatch(/not processing the refund/);
  });
  it("abort clears the reader prompt", async () => {
    const pr = makeStripe(cfg()).presentRefund!;
    replies = [{ body: reader({ type: "refund_payment", status: "in_progress" }, "stripe_s710") }];
    await pr.start("pi_1", 5, ctx, "tmr_SIM1"); calls.length = 0;
    await pr.abort("pi_1", ctx);
    expect(path(calls[0])).toBe("/terminal/readers/tmr_SIM1/cancel_action");
  });
  it("needs a reader, and an amount", async () => {
    const pr = makeStripe(cfg()).presentRefund!;
    expect((await pr.start("pi_9", 5, ctx)).message).toMatch(/No Stripe reader/);
    expect((await pr.start("pi_9", 0, ctx, "tmr_SIM1")).message).toMatch(/Nothing to refund/);
    expect(calls).toHaveLength(0);
  });
  it("a simulated reader in test mode has the matching card type presented for it", async () => {
    replies = [{ body: reader({ type: "refund_payment", status: "in_progress" }) }, { body: intent("succeeded", { latest_charge: interac() }) }, { body: reader() }];
    await makeStripe(cfg()).presentRefund!.start("pi_1", 5, ctx, "tmr_SIM1");
    expect(path(calls[2])).toBe("/test_helpers/terminal/readers/tmr_SIM1/present_payment_method"); expect(params(calls[2]).type).toBe("interac_present");
  });
});
