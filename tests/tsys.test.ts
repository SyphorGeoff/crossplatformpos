// @vitest-environment jsdom
/*
 * TSYS / TransIT API 3.0 driver — request documents (field order, amount
 * format, authentication), reply classification (A/D/E/F families, partial
 * approval), and the seam operations mapped onto Capture /
 * TipAdjustment / IncrementalAuth / Void / Return. The POS sends no card data,
 * so Auth / Sale start on the payment device (not integrated yet). The HTTP
 * seam is mocked; every exchange is checked against the spec samples in
 * docs/tsys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessorConfig } from "@/payments/config";
import type { CardRequest, CheckRef } from "@/payments/processor";
import { selectProcessor } from "@/payments/select";
import { buildTsysXml, externalRef, makeTsys, money, parseTsysReply, provisionTsysKey, recordTsysStart, resetTsys, setTsysKey, TSYS_PROD_URL, TSYS_UAT_URL, tsysKey } from "@/payments/tsys";
import type { StoreConfig } from "@/model/catalog";

const calls: Array<{ url: string; body: string }> = [];
let replies: string[] = [];
vi.mock("@/platform/http", () => ({
  httpRequest: vi.fn(async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ?? "" });
    const text = replies.shift() ?? "";
    return { ok: true, status: 200, text: async () => text, bytes: async () => new ArrayBuffer(0) };
  }),
}));

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  } as Storage;
}

const cfg = (over: Partial<ProcessorConfig> = {}): ProcessorConfig => ({
  name: "tsys", merchantId: "888900000189", bundle: { mid: "888900000189", deviceId: "26660000013601", developerId: "1234567890", testMode: true }, testMode: true, timeoutSec: 60, ...over,
});
const ctx: CheckRef = { storeId: "3", businessDateId: "90042", checkNo: "280001", checkKey: "1234567", tenderKey: "7654321", terminalPosId: "28", employeePosId: "5" };
const req = (amount: number, over: Partial<CardRequest> = {}): CardRequest => ({ ...ctx, amount, tenderId: "16", timeoutSec: 10, ...over });

const ok = (op: string, extra = "", code = "A0000", msg = "Success") =>
  `<${op}Response><status>PASS</status><responseCode>${code}</responseCode><responseMessage>${msg}</responseMessage>${extra}</${op}Response>`;
const AUTH_OK = ok("Auth", "<authCode>TAS789</authCode><hostReferenceNumber>410621751361</hostReferenceNumber><hostResponseCode>00</hostResponseCode><taskID>44002279</taskID><transactionID>43167957</transactionID><transactionTimestamp>2024-04-15T14:42:37</transactionTimestamp><transactionAmount>11.13</transactionAmount><processedAmount>11.13</processedAmount><totalAmount>11.13</totalAmount><cardType>V</cardType><maskedCardNumber>5439</maskedCardNumber><customerReceipt>PINE RESTAURANT</customerReceipt>");

beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); resetTsys(); calls.length = 0; replies = []; setTsysKey("888900000189", "S52TRZPJO9ZAS758AGOZWOI2JJ9CQ8O8"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("request documents", () => {
  it("money: dollars with a decimal point (a bare integer would be cents)", () => {
    expect(money(11.13)).toBe("11.13"); expect(money(3)).toBe("3.00"); expect(money(0.525)).toBe("0.53");
  });
  it("buildTsysXml keeps the order given, drops empty fields and escapes text", () => {
    expect(buildTsysXml("TipAdjustment", [["deviceID", "1"], ["tip", undefined], ["transactionID", "4&2"], ["developerID", ""]])).toBe("<TipAdjustment><deviceID>1</deviceID><transactionID>4&amp;2</transactionID></TipAdjustment>");
  });
  it("externalRef is alphanumeric and per tender line", () => {
    expect(externalRef(ctx)).toBe("C280001T7654321");
  });
  it("UAT vs production endpoint follows testMode", async () => {
    replies = [ok("Void", "<transactionID>1</transactionID>"), ok("Void", "<transactionID>1</transactionID>")];
    await makeTsys(cfg()).cancel("1", ctx);
    await makeTsys(cfg({ testMode: false })).cancel("1", ctx);
    expect(calls[0].url).toBe(`${TSYS_UAT_URL}/Void`); expect(calls[1].url).toBe(`${TSYS_PROD_URL}/Void`);
  });
});

describe("reply classification", () => {
  it("A0000 → ok with ids, brand, last4", () => {
    const r = parseTsysReply("Auth", AUTH_OK);
    expect(r).toMatchObject({ status: "ok", ref: "43167957", recordNo: "43167957", authCode: "TAS789", last4: "5439", brand: "VISA" });
    expect(r.receipt?.customer).toBe("PINE RESTAURANT");
  });
  it("A0002 is ok (partial); D.... declined; E/F.... error; FAIL without an A code is an error", () => {
    expect(parseTsysReply("Sale", ok("Sale", "<transactionID>1</transactionID>", "A0002", "Partially Approved")).status).toBe("ok");
    const d = parseTsysReply("Sale", `<SaleResponse><status>FAIL</status><responseCode>D0001</responseCode><responseMessage>Decline</responseMessage><transactionID>9</transactionID></SaleResponse>`);
    expect(d.status).toBe("declined"); expect(d.message).toMatch(/Decline/); expect(d.ref).toBe("9");
    expect(parseTsysReply("Sale", `<SaleResponse><status>FAIL</status><responseCode>E0001</responseCode><responseMessage>Invalid field</responseMessage></SaleResponse>`).status).toBe("error");
    expect(parseTsysReply("Sale", `<SaleResponse><status>FAIL</status><responseCode>F0001</responseCode><responseMessage>Authentication failed</responseMessage></SaleResponse>`).message).toMatch(/F0001/);
  });
  it("a non-XML or foreign body is an error, not a crash", () => {
    expect(parseTsysReply("Auth", "<html>502 Bad Gateway</html>").status).toBe("error");
    expect(parseTsysReply("Auth", "Service Unavailable").message).toMatch(/Service Unavailable/);
  });
});

describe("authorize / sale", () => {
  it("the POS sends no card data: authorize and sale are refused locally until the payment device is integrated", async () => {
    const p = makeTsys(cfg());
    for (const r of [await p.authorize(req(11.13)), await p.sale(req(10))]) { expect(r.status).toBe("error"); expect(r.message).toMatch(/payment device/); }
    expect(calls).toHaveLength(0);
  });
  it("refuses to run without the terminal's transaction key or the back-office ids", async () => {
    resetTsys();
    expect((await makeTsys(cfg()).sale(req(10))).message).toMatch(/transaction key/);
    expect((await makeTsys(cfg({ bundle: { mid: "1" } })).sale(req(10))).message).toMatch(/Device ID/);
    expect(calls).toHaveLength(0);
  });
});

describe("recording a started payment", () => {
  it("an approved Auth becomes an open authorization that status replays", async () => {
    const r = recordTsysStart(req(11.13), "auth", parseTsysReply("Auth", AUTH_OK));
    expect(r).toMatchObject({ status: "ok", ref: "43167957", authorizedAmount: 11.13, last4: "5439", brand: "VISA", tip: 0 });
    expect(r.capturedAmount).toBeUndefined();
    expect((await makeTsys(cfg()).status(r.ref!, ctx)).authCode).toBe("TAS789");
  });
  it("a Sale with a tip is captured at base + tip", () => {
    const r = recordTsysStart(req(32.63, { tip: 5 }), "sale", parseTsysReply("Sale", ok("Sale", "<authCode>TAS051</authCode><transactionID>43043955</transactionID><processedAmount>32.63</processedAmount><cardType>M</cardType><maskedCardNumber>5439</maskedCardNumber>")));
    expect(r).toMatchObject({ status: "ok", capturedAmount: 37.63, authorizedAmount: 32.63, tip: 5, brand: "MASTERCARD" });
  });
  it("partial approval: authorizedAmount is the processed amount", () => {
    const r = recordTsysStart(req(11.1), "sale", parseTsysReply("Sale", ok("Sale", "<authCode>TAS802</authCode><hostResponseCode>10</hostResponseCode><transactionID>43043881</transactionID><transactionAmount>11.10</transactionAmount><processedAmount>5.55</processedAmount><cardType>V</cardType>", "A0002", "Partially Approved")));
    expect(r.status).toBe("ok"); expect(r.authorizedAmount).toBe(5.55); expect(r.capturedAmount).toBe(5.55); expect(r.message).toMatch(/Partial/);
  });
  it("a cents-only processedAmount is read as cents", () => {
    expect(recordTsysStart(req(3), "sale", parseTsysReply("Sale", ok("Sale", "<transactionID>5</transactionID><processedAmount>300</processedAmount>"))).capturedAmount).toBe(3);
  });
  it("a decline is passed through and nothing is recorded", async () => {
    const r = recordTsysStart(req(50), "auth", parseTsysReply("Auth", `<AuthResponse><status>FAIL</status><responseCode>D0001</responseCode><responseMessage>Insufficient funds</responseMessage><transactionID>77</transactionID></AuthResponse>`));
    expect(r).toMatchObject({ status: "declined", message: "Declined — Insufficient funds" });
    expect((await makeTsys(cfg()).status("77", ctx)).status).toBe("error");
  });
});

describe("after the auth", () => {
  async function authed() {
    const p = makeTsys(cfg()); const a = recordTsysStart(req(11.13), "auth", parseTsysReply("Auth", AUTH_OK)); calls.length = 0;
    return { p, ref: a.ref! };
  }
  it("capture sends base + tip and the transactionID; a second capture is refused", async () => {
    const { p, ref } = await authed();
    replies = [ok("Capture", "<authCode>TAS789</authCode><cardType>V</cardType><transactionID>43167957</transactionID><totalAmount>13.13</totalAmount>")];
    const r = await p.capture(ref, { amount: 11.13, tip: 2 }, ctx);
    expect(calls[0].body).toBe("<Capture><deviceID>26660000013601</deviceID><transactionKey>S52TRZPJO9ZAS758AGOZWOI2JJ9CQ8O8</transactionKey><transactionAmount>11.13</transactionAmount><tip>2.00</tip><transactionID>43167957</transactionID><operatorID>EMP5</operatorID><developerID>1234567890</developerID></Capture>");
    expect(r).toMatchObject({ status: "ok", capturedAmount: 13.13, tip: 2, ref, last4: "5439" });
    expect((await p.capture(ref, { amount: 11.13, tip: 2 }, ctx)).status).toBe("error");
    expect((await p.status(ref, ctx)).capturedAmount).toBe(13.13);
  });
  it("increment sends the difference and takes the new total from the reply", async () => {
    const { p, ref } = await authed();
    replies = [ok("IncrementalAuth", "<authCode>TAS542</authCode><transactionID>43167957</transactionID><transactionAmount>6.00</transactionAmount><processedAmount>6.00</processedAmount><totalAmount>17.13</totalAmount>")];
    const r = await p.increment(ref, 17.13, ctx);
    expect(calls[0].body).toContain("<transactionID>43167957</transactionID><transactionAmount>6.00</transactionAmount>");
    expect(r).toMatchObject({ status: "ok", authorizedAmount: 17.13, ref });
    expect((await p.increment(ref, 17, ctx)).status).toBe("error");
  });
  it("adjust after capture: tip change → TipAdjustment; smaller base → partial Void; larger base refused", async () => {
    const { p, ref } = await authed();
    replies = [ok("Capture", "<transactionID>43167957</transactionID>")];
    await p.capture(ref, { amount: 11.13, tip: 2 }, ctx); calls.length = 0;
    replies = [ok("TipAdjustment", "<transactionID>43167957</transactionID><totalAmount>14.13</totalAmount><tip>3.00</tip>")];
    const r1 = await p.adjust(ref, { amount: 11.13, tip: 3 }, ctx);
    expect(calls[0].url).toMatch(/\/TipAdjustment$/); expect(calls[0].body).toContain("<tip>3.00</tip><transactionID>43167957</transactionID>");
    expect(r1).toMatchObject({ status: "ok", capturedAmount: 14.13, tip: 3 });
    calls.length = 0; replies = [ok("Void", "<transactionID>43167957</transactionID>")];
    const r2 = await p.adjust(ref, { amount: 10, tip: 3 }, ctx);
    expect(calls).toHaveLength(1); expect(calls[0].url).toMatch(/\/Void$/);
    expect(calls[0].body).toContain("<transactionAmount>1.13</transactionAmount><transactionID>43167957</transactionID>"); expect(calls[0].body).toContain("<voidReason>PARTIAL_REVERSAL</voidReason>");
    expect(r2).toMatchObject({ status: "ok", capturedAmount: 13, tip: 3 });
    expect((await p.adjust(ref, { amount: 20, tip: 3 }, ctx)).status).toBe("error");
  });
  it("cancel: full void by transactionID; partial void carries the amount", async () => {
    const { p, ref } = await authed();
    replies = [ok("Void", "<transactionID>43167957</transactionID>")];
    const r = await p.cancel(ref, ctx);
    expect(calls[0].body).toBe("<Void><deviceID>26660000013601</deviceID><transactionKey>S52TRZPJO9ZAS758AGOZWOI2JJ9CQ8O8</transactionKey><transactionID>43167957</transactionID><operatorID>EMP5</operatorID><developerID>1234567890</developerID><voidReason>POST_AUTH_USER_DECLINE</voidReason></Void>");
    expect(r.status).toBe("cancelled"); expect((await p.status(ref, ctx)).status).toBe("cancelled");
    expect((await p.capture(ref, { amount: 1, tip: 0 }, ctx)).status).toBe("error");
    const { p: p2, ref: ref2 } = await authed();
    replies = [ok("Void", "<transactionID>43167957</transactionID>")];
    const r2 = await p2.cancel(ref2, ctx, 5);
    expect(calls[0].body).toContain("<transactionAmount>5.00</transactionAmount>"); expect(calls[0].body).toContain("PARTIAL_REVERSAL"); expect(r2).toMatchObject({ status: "ok", authorizedAmount: 6.13 });
  });
  it("refund: Return with reference after capture; a new transactionID becomes the refund ref; A0014 means it was voided", async () => {
    const { p, ref } = await authed();
    expect((await p.refund(ref, 5, ctx)).message).toMatch(/void/i);
    replies = [ok("Capture", "<transactionID>43167957</transactionID>")]; await p.capture(ref, { amount: 11.13, tip: 0 }, ctx); calls.length = 0;
    replies = [ok("Return", "<authCode>TAS231</authCode><transactionID>4200819</transactionID><transactionAmount>5.00</transactionAmount><returnedAmount>5.00</returnedAmount><cardType>V</cardType><maskedCardNumber>5439</maskedCardNumber>")];
    const r = await p.refund(ref, 5, ctx);
    expect(calls[0].body).toContain("<transactionAmount>5.00</transactionAmount><transactionID>43167957</transactionID>");
    expect(r).toMatchObject({ status: "ok", ref: "4200819", capturedAmount: 5, message: "Refunded" });
    replies = [ok("Return", "<transactionID>43167957</transactionID>", "A0014", "Return requested, Void successful")];
    expect((await p.refund(ref, 11.13, ctx)).message).toMatch(/Voided/);
  });
  it("status of an unknown ref is an error (another terminal's transaction)", async () => {
    expect((await makeTsys(cfg()).status("999", ctx)).status).toBe("error");
  });
});

describe("key provisioning / registry", () => {
  it("provisionTsysKey calls GenerateKey with the admin credentials and stores only the key", async () => {
    resetTsys();
    replies = [ok("GenerateKey", "<transactionKey>1L3ARDZ462FKD4D7UEZY2B1OUHJ4IGP0</transactionKey>")];
    const r = await provisionTsysKey(cfg(), "TA5776079", "GpApi@8889");
    expect(calls[0].url).toBe(`${TSYS_UAT_URL}/GenerateKey`);
    expect(calls[0].body).toBe("<GenerateKey><mid>888900000189</mid><userID>TA5776079</userID><password>GpApi@8889</password><developerID>1234567890</developerID></GenerateKey>");
    expect(r.status).toBe("ok"); expect(tsysKey("888900000189")).toBe("1L3ARDZ462FKD4D7UEZY2B1OUHJ4IGP0");
    expect(JSON.stringify(localStorage)).not.toContain("GpApi");
    replies = [`<GenerateKeyResponse><status>FAIL</status><responseCode>F0001</responseCode><responseMessage>Invalid credentials</responseMessage></GenerateKeyResponse>`];
    expect((await provisionTsysKey(cfg(), "x", "y")).status).toBe("error");
  });
  it("the seam selects tsys from a Store whose CC_Processor is tsys", () => {
    const store = { ccProcessor: "tsys", ccTestMode: true, ccTimeoutSec: 60, merchantId: "888900000189", merchantBundle: '{"mid":"888900000189","deviceId":"26660000013601","developerId":"1234567890"}' } as unknown as StoreConfig;
    expect(selectProcessor(store)?.processor.name).toBe("tsys");
  });
});
