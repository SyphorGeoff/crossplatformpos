/*
 * Mock processor — exercises every seam path without a gateway, for dev and
 * tests. Behaves like a real host: a sale/auth comes back `pending` first and
 * settles on the next status poll (so the processing overlay and polling run),
 * captures/adjusts/voids are checked against the stored transaction, and the
 * amount's cents steer the outcome so each case is reproducible:
 *   .99 → declined        .98 → error (host unreachable)
 *   .97 → partial approval (half the amount)   .96 → stays pending until cancelled
 * The brand of a "presented" card cycles VISA / MASTERCARD / AMEX.
 * Transactions persist in storage so a finalize after a reload still finds them.
 */

import { loadJSON, saveJSON } from "@/platform/storage";
import { declined, failed, type CardAmounts, type CardBrand, type CardProcessor, type CardRequest, type CardResult, type CheckRef } from "./processor";

const KEY = "payments.mock.v1";
const SETTLE_MS = 1200;

interface MockTxn {
  ref: string; kind: "auth" | "sale"; amount: number; tip: number; captured: boolean; voided: boolean; refunded: number;
  authorizedAmount: number; brand: CardBrand; last4: string; authCode: string; createdAt: number; pendingForever: boolean;
  checkNo: string; tenderKey: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100) % 100;

function load(): Record<string, MockTxn> { return loadJSON<Record<string, MockTxn>>(KEY, {}); }
function save(all: Record<string, MockTxn>): void { saveJSON(KEY, all); }
function get(ref: string): MockTxn | undefined { return load()[ref]; }
function put(t: MockTxn): void { const all = load(); all[t.ref] = t; save(all); }

let seq = 0;
const nextRef = () => `MK${Date.now().toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase()}`;
const brands: CardBrand[] = ["VISA", "MASTERCARD", "AMEX"];

function result(t: MockTxn, status: CardResult["status"], message: string): CardResult {
  return {
    status, message, ref: t.ref, recordNo: t.ref, authCode: t.authCode, last4: t.last4, brand: t.brand,
    authorizedAmount: t.authorizedAmount, capturedAmount: t.captured ? round2(t.amount + t.tip) : undefined, tip: t.tip,
  };
}

function start(req: CardRequest, kind: "auth" | "sale"): CardResult {
  const c = cents(req.amount);
  if (c === 98) return failed("Host unreachable (mock .98)");
  const existing = Object.values(load()).find((t) => t.tenderKey === req.tenderKey && t.checkNo === req.checkNo && !t.voided);
  if (existing) return result(existing, existing.pendingForever ? "pending" : "ok", "Already processed (idempotent)");
  const brand = brands[seq % brands.length];
  const last4 = String(1000 + ((seq * 37) % 9000));
  const tip = round2(req.tip ?? 0);
  const t: MockTxn = {
    ref: nextRef(), kind, amount: round2(req.amount), tip, captured: false, voided: false, refunded: 0,
    authorizedAmount: c === 97 ? round2(req.amount / 2) : round2(req.amount), brand, last4,
    authCode: `OK${100000 + Math.floor(Math.random() * 900000)}`, createdAt: Date.now(), pendingForever: c === 96,
    checkNo: req.checkNo, tenderKey: req.tenderKey,
  };
  if (c === 99) { t.voided = true; put(t); return declined("Declined (mock .99)", { ref: t.ref, last4, brand }); }
  if (c === 97) t.amount = t.authorizedAmount;
  put(t);
  return { ...result(t, "pending", "Processing…"), authorizedAmount: undefined };
}

export const mockProcessor: CardProcessor = {
  name: "mock",
  async authorize(req) { return start(req, "auth"); },
  async sale(req) { return start(req, "sale"); },
  async status(ref) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (t.voided) return result(t, "cancelled", "Voided");
    if (t.pendingForever) return result(t, "pending", "Waiting for the device…");
    if (Date.now() - t.createdAt < SETTLE_MS) return result(t, "pending", "Processing…");
    if (t.kind === "sale" && !t.captured) { t.captured = true; put(t); }
    return result(t, "ok", t.authorizedAmount < t.amount + 0.005 && t.kind === "auth" && cents(t.amount) === 97 ? "Partial approval" : "Approved");
  },
  async capture(ref, amounts: CardAmounts) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (t.voided) return failed("Transaction was voided");
    if (t.captured) return failed("Already captured");
    t.amount = round2(amounts.amount); t.tip = round2(amounts.tip); t.captured = true; put(t);
    return result(t, "ok", "Captured");
  },
  async adjust(ref, amounts: CardAmounts) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (t.voided) return failed("Transaction was voided");
    t.amount = round2(amounts.amount); t.tip = round2(amounts.tip); put(t);
    return result(t, "ok", "Adjusted");
  },
  async increment(ref, newAmount: number) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (t.captured || t.voided) return failed("Not an open authorization");
    t.amount = round2(newAmount); t.authorizedAmount = round2(newAmount); put(t);
    return result(t, "ok", "Authorization increased");
  },
  async cancel(ref, _ctx: CheckRef, amount?: number) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (amount !== undefined && amount < t.amount + t.tip - 0.005) { t.amount = round2(t.amount - amount); put(t); return result(t, "ok", "Partially voided"); }
    t.voided = true; put(t);
    return result(t, "cancelled", "Voided");
  },
  async refund(ref, amount: number) {
    const t = get(ref);
    if (!t) return failed("Unknown transaction");
    if (!t.captured) return failed("Not captured — void it instead");
    t.refunded = round2(t.refunded + amount); put(t);
    return { ...result(t, "ok", "Refunded"), ref: `${t.ref}R`, recordNo: `${t.ref}R` };
  },
};

/** Test/dev helper: forget every mock transaction. */
export function resetMock(): void { save({}); seq = 0; }
