/*
 * Stripe Terminal SDK driver — the parts that run without a device: mapping the plugin's
 * intent summary and errors onto the seam, the simulated-card steering, and the transport
 * switch that decides between the SDK driver and REST (REST wherever the plugin is absent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sdkFailure, sdkIntentResult, sdkReceiptLines, simulatedCardFor } from "@/payments/stripeSdk";
import { effectiveStripeTransport, sdkAvailable, setStripeTransport, stripeTransportSetting } from "@/payments/transport";
import { selectProcessor } from "@/payments/select";
import "@/payments/stripe";
import type { IntentSummary } from "@/platform/stripeterminal";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}
beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); });

const approved: IntentSummary = {
  id: "pi_1", status: "SUCCEEDED", amount: 1150, tipAmount: 150, currency: "cad",
  charge: { id: "ch_1", status: "succeeded", authorizationCode: "123456", captured: true, amount: 1150, type: "card_present",
    card: { brand: "visa", last4: "4242", readMethod: "contactless_emv", funding: "credit", receipt: { accountType: "credit", applicationPreferredName: "VISA CREDIT", dedicatedFileName: "A0000000031010", terminalVerificationResults: "0000008000", transactionStatusInformation: "E800", applicationCryptogram: "ABCD" } } },
};

describe("sdkIntentResult", () => {
  it("maps an approved sale: ok, ids, card, tip, receipt lines", () => {
    const r = sdkIntentResult(approved, "pi_1");
    expect(r.status).toBe("ok"); expect(r.message).toBe("Approved");
    expect(r.ref).toBe("pi_1"); expect(r.recordNo).toBe("ch_1"); expect(r.authCode).toBe("123456");
    expect(r.brand).toBe("VISA"); expect(r.last4).toBe("4242"); expect(r.tip).toBe(1.5); expect(r.capturedAmount).toBe(11.5);
    expect(r.receipt?.customer).toContain("Account: credit"); expect(r.receipt?.customer).toContain("ENTRY: contactless emv");
  });
  it("maps a hold (requires_capture) to ok/Authorized and an offline one says so", () => {
    expect(sdkIntentResult({ ...approved, status: "REQUIRES_CAPTURE" }, "pi_1").message).toBe("Authorized");
    const off = sdkIntentResult({ ...approved, id: null, status: "REQUIRES_CAPTURE", charge: undefined, offline: { requiresUpload: true, storedAtMs: 1, card: { brand: "mastercard", last4: "4444" } } }, "off_t1");
    expect(off.status).toBe("ok"); expect(off.message).toBe("Authorized (stored offline)"); expect(off.ref).toBe("off_t1"); expect(off.brand).toBe("MASTERCARD");
  });
  it("Interac charges report INTERAC", () => {
    expect(sdkIntentResult({ ...approved, charge: { ...approved.charge, type: "interac_present" } }, "pi_1").brand).toBe("INTERAC");
  });
  it("a last_payment_error becomes a decline", () => {
    const r = sdkIntentResult({ ...approved, status: "REQUIRES_PAYMENT_METHOD", charge: undefined, lastPaymentError: { code: "card_declined", declineCode: "insufficient_funds", message: "Your card has insufficient funds.", type: "card_error" } }, "pi_1");
    expect(r.status).toBe("declined"); expect(r.message).toContain("insufficient funds");
  });
  it("cancelled and pending states", () => {
    expect(sdkIntentResult({ status: "CANCELED" }, "pi_1").status).toBe("cancelled");
    expect(sdkIntentResult({ status: "REQUIRES_PAYMENT_METHOD" }, "pi_1").status).toBe("pending");
  });
});

describe("sdkFailure", () => {
  it("reader cancel → cancelled", () => { expect(sdkFailure({ code: "CANCELED_BY_READER", cancelled: true }, "pi_1")).toMatchObject({ status: "cancelled", message: "Cancelled on the reader" }); });
  it("decline with a decline code", () => { expect(sdkFailure({ code: "DECLINED_BY_STRIPE_API", declined: true, apiError: { declineCode: "generic_decline", message: "Declined" } }, "pi_1")).toMatchObject({ status: "declined" }); });
  it("anything else is an error carrying the message", () => { expect(sdkFailure({ code: "NOT_CONNECTED_TO_READER", message: "no reader" }, "pi_1")).toMatchObject({ status: "error", message: "Reader: no reader" }); });
});

describe("simulated card steering (same cents as REST)", () => {
  it.each([[10.99, "CHARGE_DECLINED"], [10.98, "CHARGE_DECLINED_PROCESSING_ERROR"], [10.97, "CHARGE_DECLINED_INSUFFICIENT_FUNDS"], [10.95, "AMEX"], [10.94, "MASTERCARD"], [10, "VISA"]])("%s → %s", (amt, type) => {
    expect(simulatedCardFor(amt)?.cardType).toBe(type);
  });
  it(".96 leaves the simulator alone", () => { expect(simulatedCardFor(10.96)).toBeNull(); });
  it("receipt lines omit unknown account", () => { expect(sdkReceiptLines({ funding: "unknown", readMethod: "contact_emv" })).toBe("ENTRY: contact emv"); });
});

describe("transport switch", () => {
  it("defaults to sdk, persists rest", () => {
    expect(stripeTransportSetting()).toBe("sdk");
    setStripeTransport("rest"); expect(stripeTransportSetting()).toBe("rest");
  });
  it("is forced to rest without the plugin (web / node), so the registry hands out the REST driver", () => {
    expect(sdkAvailable()).toBe(false);
    setStripeTransport("sdk");
    expect(effectiveStripeTransport()).toBe("rest");
    const store = { ccProcessor: "stripe", merchantBundle: JSON.stringify({ secretKey: "sk_test_x", testMode: true }), merchantId: "", ccTestMode: true, ccTimeoutSec: 30 } as unknown as Parameters<typeof selectProcessor>[0];
    const sel = selectProcessor(store);
    expect(sel?.processor.name).toBe("stripe");
    // The REST driver refuses authorize() without a reader; the SDK driver would say the SDK is unavailable.
    return sel!.processor.authorize({ amount: 10, tenderId: "1", timeoutSec: 30, storeId: "3", businessDateId: "1", checkNo: "1", checkKey: "k", tenderKey: "t", terminalPosId: "28", employeePosId: "5" })
      .then((r) => { expect(r.status).toBe("error"); expect(r.message).toMatch(/reader/i); });
  });
});
