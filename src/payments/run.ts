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
