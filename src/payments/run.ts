/*
 * Run a card operation to completion. A processor may answer `pending` (the
 * device is prompting, the host is thinking); this polls `status(ref)` until
 * the result settles, the deadline passes, or the caller cancels. The UI gets
 * progress callbacks for its overlay; the final result is one CardResult.
 */

import type { CardProcessor, CardResult, CheckRef } from "./processor";

export interface RunHandle { cancel: () => void; }

export interface RunOpts {
  timeoutSec: number;
  pollMs?: number;
  onProgress?: (r: CardResult) => void;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** Start `op` and, while it reports pending, poll until done. Returns the
 *  settled result plus a handle whose cancel() asks the processor to void the
 *  in-flight transaction and resolves the run as cancelled. */
export function runCard(processor: CardProcessor, ctx: CheckRef, op: () => Promise<CardResult>, opts: RunOpts): { done: Promise<CardResult>; handle: RunHandle } {
  let cancelled = false;
  let ref: string | undefined;
  const handle: RunHandle = { cancel: () => { cancelled = true; } };
  const deadline = Date.now() + Math.max(5, opts.timeoutSec) * 1000;
  const pollMs = opts.pollMs ?? 1000;

  const done = (async (): Promise<CardResult> => {
    let r: CardResult;
    try { r = await op(); } catch (e) { return { status: "error", message: `processor error: ${String((e as Error).message ?? e)}` }; }
    ref = r.ref;
    opts.onProgress?.(r);
    while (r.status === "pending") {
      if (cancelled) break;
      if (Date.now() > deadline) {
        if (ref) { try { await processor.cancel(ref, ctx); } catch { /* best effort */ } }
        return { status: "error", message: "Timed out waiting for the processor", ref };
      }
      await sleep(pollMs);
      if (!ref) return { status: "error", message: "Processor returned pending without a reference" };
      try { r = await processor.status(ref, ctx); } catch (e) { return { status: "error", message: `processor error: ${String((e as Error).message ?? e)}`, ref }; }
      opts.onProgress?.(r);
    }
    if (cancelled && r.status === "pending") {
      if (ref) { try { await processor.cancel(ref, ctx); } catch { /* best effort */ } }
      return { status: "cancelled", message: "Cancelled", ref };
    }
    return r;
  })();

  return { done, handle };
}

export interface UndoOpts {
  timeoutSec: number;
  pollMs?: number;
  /** The payment sits on a debit tender (Is_Debit): refund it with the card present from the start. */
  debit?: boolean;
  /** What to give back when going straight to the device (debit). */
  amount?: number;
  /** The payment device to prompt on (the terminal's Terminal ID). */
  readerId?: string;
  /** The card-present refund started: show the prompt; `handle.cancel()` abandons it. */
  onPresent?: (handle: RunHandle, amount: number) => void;
  onProgress?: (r: CardResult) => void;
}

/** Give money back on a card payment — a void, a refund, a tip reduction, a shrunk sale.
 *  `attempt` is the ordinary processor call (cancel / refund / adjust). Two roads lead to a card-present refund:
 *   - the payment is debit (Is_Debit): it goes to the device at once, the ordinary call is not tried;
 *   - the ordinary call comes back `needsCardPresent` (Interac always; some processors after the batch closes).
 *  The result is `ok` only when the device confirms the refund; a cancelled or timed-out prompt is an error
 *  and the payment stands. A processor without a card-present refund just returns the ordinary result. */
export async function undoCard(processor: CardProcessor, ref: string, ctx: CheckRef, attempt: () => Promise<CardResult>, opts: UndoOpts): Promise<CardResult> {
  const pr = processor.presentRefund;
  const guard = async (fn: () => Promise<CardResult>): Promise<CardResult> => {
    try { return await fn(); } catch (e) { return { status: "error", message: `processor error: ${String((e as Error).message ?? e)}`, ref }; }
  };

  const present = async (amount: number): Promise<CardResult> => {
    if (!pr) return { status: "error", message: "This processor cannot refund with the card present", ref };
    let cancelled = false;
    opts.onPresent?.({ cancel: () => { cancelled = true; } }, amount);
    const deadline = Date.now() + Math.max(5, opts.timeoutSec) * 1000;
    const stop = async (message: string): Promise<CardResult> => {
      try { await pr.abort(ref, ctx); } catch { /* the device may already be idle */ }
      return { status: "error", message, ref };
    };
    let r = await guard(() => pr.start(ref, amount, ctx, opts.readerId));
    opts.onProgress?.(r);
    while (r.status === "pending") {
      if (cancelled) return stop("Refund cancelled — the payment stands");
      if (Date.now() > deadline) return stop("Timed out waiting for the card — the payment stands");
      await sleep(opts.pollMs ?? 1000);
      r = await guard(() => pr.status(ref, ctx));
      opts.onProgress?.(r);
    }
    if (r.status === "cancelled") return { status: "error", message: "Refund cancelled on the device — the payment stands", ref };
    return r;
  };

  if (opts.debit && pr && (opts.amount ?? 0) > 0) return present(opts.amount!);
  const r = await guard(attempt);
  if (r.needsCardPresent && pr && r.needsCardPresent.amount > 0) return present(r.needsCardPresent.amount);
  return r;
}
