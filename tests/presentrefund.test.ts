/*
 * undoCard (payments/run.ts) — giving money back on a card payment, with the
 * card-present refund: straight to the device for a debit payment (Is_Debit),
 * and as the fallback when the processor says the refund must be made in person.
 */

import { describe, expect, it, vi } from "vitest";
import type { CardProcessor, CardResult, CheckRef, PresentRefund } from "@/payments/processor";
import { undoCard, type RunHandle } from "@/payments/run";

const ctx: CheckRef = { storeId: "3", businessDateId: "90042", checkNo: "280001", checkKey: "1", tenderKey: "7", terminalPosId: "28", employeePosId: "5" };
const nope = async (): Promise<CardResult> => ({ status: "error", message: "not used" });
const proc = (pr?: PresentRefund): CardProcessor => ({ name: "mock", authorize: nope, sale: nope, capture: nope, adjust: nope, increment: nope, cancel: nope, refund: nope, status: nope, presentRefund: pr });

/** A device that answers `pending` for the given number of polls, then `final`. */
function device(pendingPolls: number, final: CardResult) {
  let polls = 0;
  const pr = {
    start: vi.fn(async (ref: string): Promise<CardResult> => ({ status: "pending", message: "Present the card", ref })),
    status: vi.fn(async (): Promise<CardResult> => (polls++ < pendingPolls ? { status: "pending", message: "waiting" } : final)),
    abort: vi.fn(async () => {}),
  };
  return pr;
}
const opts = { timeoutSec: 30, pollMs: 2 };

describe("undoCard", () => {
  it("a debit payment goes straight to the device; the ordinary call is never tried", async () => {
    const pr = device(2, { status: "ok", message: "Refunded on the reader", ref: "pi_1" });
    const attempt = vi.fn(nope);
    const shown: number[] = [];
    const r = await undoCard(proc(pr), "pi_1", ctx, attempt, { ...opts, debit: true, amount: 12.5, readerId: "tmr_1", onPresent: (_h, amt) => shown.push(amt) });
    expect(r.status).toBe("ok"); expect(attempt).not.toHaveBeenCalled();
    expect(pr.start).toHaveBeenCalledWith("pi_1", 12.5, ctx, "tmr_1"); expect(shown).toEqual([12.5]);
  });
  it("an ordinary void that succeeds never touches the device", async () => {
    const pr = device(0, { status: "ok", message: "x" });
    const r = await undoCard(proc(pr), "pi_1", ctx, async () => ({ status: "cancelled", message: "Cancelled", ref: "pi_1" }), opts);
    expect(r.status).toBe("cancelled"); expect(pr.start).not.toHaveBeenCalled();
  });
  it("falls back to the device, for the amount the processor names, when it says the card must be present", async () => {
    const pr = device(1, { status: "ok", message: "Refunded on the reader", ref: "pi_1" });
    const r = await undoCard(proc(pr), "pi_1", ctx, async () => ({ status: "error", message: "in person only", needsCardPresent: { amount: 3 } }), { ...opts, readerId: "tmr_1" });
    expect(r.status).toBe("ok"); expect(pr.start).toHaveBeenCalledWith("pi_1", 3, ctx, "tmr_1");
  });
  it("Cancel on the prompt aborts the device and the payment stands", async () => {
    const pr = device(1000, { status: "ok", message: "x" });
    let handle: RunHandle | undefined;
    const run = undoCard(proc(pr), "pi_1", ctx, nope, { ...opts, debit: true, amount: 5, onPresent: (h) => { handle = h; } });
    await new Promise((res) => setTimeout(res, 10));
    handle!.cancel();
    const r = await run;
    expect(r.status).toBe("error"); expect(r.message).toMatch(/payment stands/); expect(pr.abort).toHaveBeenCalledTimes(1);
  });
  it("a refund cancelled or declined on the device is not a successful void", async () => {
    const a = await undoCard(proc(device(0, { status: "cancelled", message: "Cancelled on the reader" })), "pi_1", ctx, nope, { ...opts, debit: true, amount: 5 });
    expect(a.status).toBe("error"); expect(a.message).toMatch(/payment stands/);
    const b = await undoCard(proc(device(0, { status: "error", message: "Reader: wrong card" })), "pi_1", ctx, nope, { ...opts, debit: true, amount: 5 });
    expect(b).toMatchObject({ status: "error", message: "Reader: wrong card" });
  });
  it("a processor with no card-present refund just returns the ordinary result", async () => {
    const attempt = vi.fn(async (): Promise<CardResult> => ({ status: "error", message: "in person only", needsCardPresent: { amount: 3 } }));
    const r = await undoCard(proc(), "pi_1", ctx, attempt, { ...opts, debit: true, amount: 5 });
    expect(attempt).toHaveBeenCalledTimes(1); expect(r.message).toBe("in person only");
  });
  it("a debit tip increase (nothing to give back) takes the ordinary road", async () => {
    const pr = device(0, { status: "ok", message: "x" });
    const r = await undoCard(proc(pr), "pi_1", ctx, async () => ({ status: "error", message: "cannot be increased" }), { ...opts, debit: true, amount: 0 });
    expect(r.message).toBe("cannot be increased"); expect(pr.start).not.toHaveBeenCalled();
  });
  it("a throwing processor call becomes an error result", async () => {
    const r = await undoCard(proc(), "pi_1", ctx, async () => { throw new Error("offline"); }, opts);
    expect(r).toMatchObject({ status: "error" }); expect(r.message).toMatch(/offline/);
  });
});
