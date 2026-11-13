/*
 * Where the tip is asked. The app's tip pad belongs to offline tenders only; for a card
 * the device prompts on a one-shot sale and finalize takes it on an auth (Geoff 2026-11-13:
 * in Pay At Table the guest keys the tip on the reader, never the waiter on the app).
 */
import { describe, expect, it } from "vitest";
import { appTipPadApplies } from "@/views/PaymentView";

describe("app tip pad", () => {
  it("runs for an offline tender that asks for a tip", () => { expect(appTipPadApplies({ askForTip: true, isOnline: false })).toBe(true); });
  it("never runs for a card tender, whatever Ask_For_Tip says", () => {
    expect(appTipPadApplies({ askForTip: true, isOnline: true })).toBe(false);
    expect(appTipPadApplies({ askForTip: false, isOnline: true })).toBe(false);
  });
  it("skips an offline tender that does not ask", () => { expect(appTipPadApplies({ askForTip: false, isOnline: false })).toBe(false); });
});
