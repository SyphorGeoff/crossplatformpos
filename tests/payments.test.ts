/*
 * Payments seam — processor selection from the definitions, the bundle parser,
 * the mock processor's state machine, and runCard's pending/poll/timeout/cancel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RevenueCenter, StoreConfig } from "@/model/catalog";
import { parseBundle, processorConfig } from "@/payments/config";
import { mockProcessor, resetMock } from "@/payments/mock";
import { brandFromText, type CardRequest, type CheckRef } from "@/payments/processor";
import { runCard } from "@/payments/run";
import { selectProcessor } from "@/payments/select";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  } as Storage;
}

const store = (over: Partial<StoreConfig> = {}): StoreConfig => ({
  usePin: false, enterpriseId: "3", imageServerUrl: "", gcProcessor: "", loyaltyProcessor: "", gcMerchantId: "", gcMerchantPassword: "",
  loyaltyMerchantId: "", loyaltyMerchantPassword: "", allowRefire: false, maxCheckAmount: 1e6, printCourseLine: false, chitItemSpacing: false,
  terminalTimeoutSec: 0, gcMenuItemId: "", gcReloadMenuItemId: "", useSyphor: false,
  ccProcessor: "", ccTestMode: false, ccTimeoutSec: 60, requireAuthTip: false, maxTipPercent: 50, merchantId: "", merchantBundle: "", hostbasedCc: false,
  ...over,
});
const rc = (over: Partial<RevenueCenter> = {}): RevenueCenter => ({
  id: "1", name: "Bar", screenGroupFilter: false, alwaysAskForTab: false, disableAutoGrat: false, timeoutActive: true, logoutAfterPayment: false,
  showCourse: false, useCourseButtons: false, guestBeforeCourse: false, useRcCcProcessor: false, ccProcessor: "", ccMerchantId: "", ccMerchantBundle: "", _raw: {}, ...over,
});
const ctx: CheckRef = { storeId: "3", businessDateId: "90042", checkNo: "280001", checkKey: "1234567", tenderKey: "7654321", terminalPosId: "28", employeePosId: "5" };
const req = (amount: number, over: Partial<CardRequest> = {}): CardRequest => ({ ...ctx, amount, tenderId: "16", timeoutSec: 10, ...over });

beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); resetMock(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("parseBundle", () => {
  it("reads plain, html-escaped and single-quoted JSON; junk → {}", () => {
    expect(parseBundle('{"mid":"8888","deviceId":"123","testMode":true}')).toEqual({ mid: "8888", deviceId: "123", testMode: true });
    expect(parseBundle("{&quot;accountId&quot;:&quot;acct_1&quot;}")).toEqual({ accountId: "acct_1" });
    expect(parseBundle("{'mid':'1'}")).toEqual({ mid: "1" });
    expect(parseBundle("sq0csp-secret")).toEqual({});
    expect(parseBundle("")).toEqual({});
  });
});

describe("processorConfig / selectProcessor", () => {
  it("unknown or empty processor → null (online tenders stay disabled)", () => {
    expect(selectProcessor(store({ ccProcessor: "square" }))).toBeNull();
    expect(selectProcessor(store({ ccProcessor: "" }))).toBeNull();
    expect(processorConfig(store({ ccProcessor: "converge" })).name).toBe("");
  });
  it("mock is registered; tsys/stripe are recognized names (module may not be registered yet)", () => {
    expect(selectProcessor(store({ ccProcessor: "MOCK" }))?.processor.name).toBe("mock");
    expect(processorConfig(store({ ccProcessor: "tsys" })).name).toBe("tsys");
    expect(processorConfig(store({ ccProcessor: "stripe" })).name).toBe("stripe");
  });
  it("the revenue center overrides the store only when use_RC_CC_Processor is on", () => {
    const s = store({ ccProcessor: "tsys", merchantId: "STOREMID", merchantBundle: '{"mid":"STOREMID"}' });
    expect(processorConfig(s, rc({ useRcCcProcessor: false, ccProcessor: "stripe" })).name).toBe("tsys");
    const c = processorConfig(s, rc({ useRcCcProcessor: true, ccProcessor: "stripe", ccMerchantId: "acct_rc", ccMerchantBundle: '{"locationId":"tml_1"}' }));
    expect(c.name).toBe("stripe"); expect(c.merchantId).toBe("acct_rc"); expect(c.bundle.locationId).toBe("tml_1");
  });
  it("test mode = Store cc_test_mode or the bundle flag; timeout defaults to 60", () => {
    expect(processorConfig(store({ ccProcessor: "tsys", ccTestMode: true })).testMode).toBe(true);
    expect(processorConfig(store({ ccProcessor: "tsys", merchantBundle: '{"testMode":true}' })).testMode).toBe(true);
    expect(processorConfig(store({ ccProcessor: "tsys", ccTimeoutSec: 0 })).timeoutSec).toBe(60);
  });
});

describe("brandFromText", () => {
  it("maps processor brand codes to iCat_Code vocabulary", () => {
    expect(brandFromText("V")).toBe("VISA"); expect(brandFromText("mastercard")).toBe("MASTERCARD");
    expect(brandFromText("X")).toBe("AMEX"); expect(brandFromText("R")).toBe("DISCOVER"); expect(brandFromText("interac")).toBe("INTERAC"); expect(brandFromText("zz")).toBe("OTHER"); expect(brandFromText("")).toBeUndefined();
  });
});

describe("mock processor", () => {
  it("sale: pending first, then approved on status; captured amount includes the tip", async () => {
    const r1 = await mockProcessor.sale(req(20, { tip: 4 }));
    expect(r1.status).toBe("pending"); expect(r1.ref).toBeTruthy();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5000);
    const r2 = await mockProcessor.status(r1.ref!, ctx);
    vi.useRealTimers();
    expect(r2.status).toBe("ok"); expect(r2.capturedAmount).toBe(24); expect(r2.authCode).toMatch(/^OK\d{6}$/); expect(r2.last4).toMatch(/^\d{4}$/);
  });
  it("auth → capture with tip; a second capture is refused; adjust changes a captured sale", async () => {
    const a = await mockProcessor.authorize(req(30));
    const cap = await mockProcessor.capture(a.ref!, { amount: 30, tip: 6 }, ctx);
    expect(cap.status).toBe("ok"); expect(cap.capturedAmount).toBe(36);
    expect((await mockProcessor.capture(a.ref!, { amount: 30, tip: 6 }, ctx)).status).toBe("error");
    const adj = await mockProcessor.adjust(a.ref!, { amount: 25, tip: 5 }, ctx);
    expect(adj.status).toBe("ok"); expect(adj.capturedAmount).toBe(30);
  });
  it("increment raises an open auth; cancel voids; refund needs a capture", async () => {
    const a = await mockProcessor.authorize(req(10));
    expect((await mockProcessor.increment(a.ref!, 18, ctx)).authorizedAmount).toBe(18);
    expect((await mockProcessor.refund(a.ref!, 5, ctx)).status).toBe("error");
    expect((await mockProcessor.cancel(a.ref!, ctx)).status).toBe("cancelled");
    expect((await mockProcessor.capture(a.ref!, { amount: 18, tip: 0 }, ctx)).status).toBe("error");
  });
  it("cents steer the outcome: .99 declined, .98 error, .97 partial", async () => {
    expect((await mockProcessor.sale(req(10.99))).status).toBe("declined");
    expect((await mockProcessor.sale(req(10.98, { tenderKey: "k2" }))).status).toBe("error");
    const p = await mockProcessor.authorize(req(20.97, { tenderKey: "k3" }));
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5000);
    const s = await mockProcessor.status(p.ref!, ctx);
    vi.useRealTimers();
    expect(s.status).toBe("ok"); expect(s.authorizedAmount).toBe(10.49);
  });
  it("is idempotent per tender line key", async () => {
    const a = await mockProcessor.sale(req(12));
    const b = await mockProcessor.sale(req(12));
    expect(b.ref).toBe(a.ref);
  });
});

describe("runCard", () => {
  it("polls a pending result until it settles", async () => {
    const run = runCard(mockProcessor, ctx, () => mockProcessor.sale(req(8)), { timeoutSec: 10, pollMs: 5 });
    const r = await run.done;
    expect(r.status).toBe("ok"); expect(r.ref).toBeTruthy();
  }, 10000);
  it("cancel() voids the in-flight transaction and resolves cancelled", async () => {
    const run = runCard(mockProcessor, ctx, () => mockProcessor.sale(req(9.96)), { timeoutSec: 10, pollMs: 5 });
    setTimeout(() => run.handle.cancel(), 20);
    const r = await run.done;
    expect(r.status).toBe("cancelled");
    expect((await mockProcessor.status(r.ref!, ctx)).status).toBe("cancelled");
  });
  it("times out a transaction that never settles", async () => {
    const run = runCard(mockProcessor, ctx, () => mockProcessor.sale(req(7.96)), { timeoutSec: 5, pollMs: 5 });
    const started = Date.now();
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
    vi.setSystemTime(started + 6000);
    const r = await run.done;
    vi.useRealTimers();
    expect(r.status).toBe("error"); expect(r.message).toMatch(/Timed out/);
  }, 10000);
  it("an op that throws becomes an error result", async () => {
    const r = await runCard(mockProcessor, ctx, async () => { throw new Error("boom"); }, { timeoutSec: 5 }).done;
    expect(r.status).toBe("error"); expect(r.message).toMatch(/boom/);
  });
});
