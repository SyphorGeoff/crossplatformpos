/*
 * Payment view — settle the check. Tenders are classified from the Tender
 * definition (cash / room-charge / native gift / native loyalty / credit).
 * Cash takes an amount and returns change; native gift does a balance inquiry
 * then redeem via <Payment> to HBroker; room charge records offline against a
 * room number. Credit tenders that are NOT Is_Online are offline "dummy"
 * payments (makePayment: no processor → a plain Type="T" line). Online card
 * tenders go through the processor seam (payments/processor.ts) when the
 * store has a processor (`card` prop): auth-then-capture for table service,
 * one-shot sale when the terminal is Pay_At_Table or the tender auto-captures; declines / partial
 * approvals / cancel handled on the sheet. When the balance reaches zero the
 * check is settled (the FinancialCheck re-POST with Is_Closed/Is_Settled).
 *
 * Tips (CheckViewController tips block :3240+): Ask_For_Tip → tip pad after the
 * amount; Overpay_Is_Tip → anything above the balance is the tip; a tip of 50%
 * or more of the balance needs a manager (TIP_AUTH). Divide By (DIVIDE_BY):
 * a count pad sets N; each payment defaults to balance ÷ N and N steps down
 * with every payment until the check closes.
 */

import { useRef, useState } from "react";
import { checkSubtotal, isCardLine, isUncapturedCard, openHold, tenderApplied, type Check, type TenderLine } from "@/model/check";
import { balanceWithTax, grandTotal, type TaxResult } from "@/model/tax";
import type { Tender } from "@/model/catalog";
import type { GiftType, LoyaltyType, PaymentResult } from "@/protocol/payment";
import type { CardBrand, CardProcessor, CardResult, CheckRef } from "@/payments/processor";
import { runCard, undoCard, type RunHandle } from "@/payments/run";
import NumberPad from "./NumberPad";

const fmt = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const round2 = (n: number) => Math.round(n * 100) / 100;

type Mode = { kind: "tenders" } | { kind: "cash" } | { kind: "gift"; tender: Tender } | { kind: "room"; tender: Tender }
  | { kind: "card"; tender: Tender } | { kind: "tip"; tender: Tender; amount: number } | { kind: "divide" }
  | { kind: "processing"; tender: Tender; text: string }                     // waiting on the processor / device
  | { kind: "refunding"; title: string; text: string }                       // card-present refund: waiting for the card on the device
  | { kind: "tabtip"; line: TenderLine };                                     // Finish Tab: the tip before the capture

/** What the sheet needs from the processor seam when the store has one. */
export interface CardSupport {
  processor: CardProcessor;
  processorName: string;
  payAtTable: boolean;          // Terminal Pay_At_Table_Active → one-shot sale (tip first) instead of auth-then-capture
  readerId: string;             // Terminal TyroTerminalID
  timeoutSec: number;           // Store CC_Timeout
  maxTipPercent: number;        // Store Max_Tip_Percent (TIP_AUTH threshold)
  testMode: boolean;
  checkRef: (tenderKey: string) => CheckRef;             // the check identity for the seam
  brandTender: (brand: CardBrand) => Tender | undefined;  // brand → the Visa/MC/Amex/Discover tender (iCat_Code)
  mintKey: () => string;                                  // lineitemkey for the new tender line
  /** Re-fit a posted card line to a new amount (void shrank the check / an item grew it). */
  resize?: (key: string, newAmount: number) => Promise<{ ok: boolean; message: string }>;
  /** Terminal "Bar Tabs" (use_RepeatSale): Open Tab / Finish Tab / Void Tab on the sheet. */
  barTabs: boolean;
  /** Finish Tab: capture the hold for base + tip, record the tip on the server line (Finalize_Tender), mark it finalized. */
  finishTab?: (key: string, tip: number) => Promise<{ ok: boolean; message: string }>;
}

export interface PaymentViewProps {
  check: Check;
  tax: TaxResult;
  tenders: Tender[];
  applyTender: (t: Omit<TenderLine, "key"> & { key?: string }) => void;
  voidTender: (key: string) => void;                 // unsent tender: just removed
  voidPostedTender?: (key: string) => void;          // posted tender: void auth + reason, reversal posted
  processGift: (card: string, type: GiftType | LoyaltyType, amount: number) => Promise<PaymentResult>;
  settle: () => Promise<{ ok: boolean; message: string }>;
  /** Manager authorization (TIP_AUTH) — runs onOk once an authorizer is confirmed. */
  authorize: (title: string, onOk: () => void) => void;
  /** Online card processing; absent = no processor configured, online tenders stay disabled. */
  card?: CardSupport;
  onClose: () => void;
  onClosed: () => void;
}

export default function PaymentView(p: PaymentViewProps) {
  const subtotal = checkSubtotal(p.check);
  const paid = tenderApplied(p.check);
  const due = balanceWithTax(subtotal, p.tax, paid);
  const total = grandTotal(subtotal, p.tax);
  const [mode, setMode] = useState<Mode>({ kind: "tenders" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const runRef = useRef<RunHandle | null>(null);     // the in-flight card operation (Cancel on the overlay)
  const [divideNum, setDivideNum] = useState(1);   // DIVIDE_BY — ways left to split the balance
  const share = divideNum > 1 ? round2(due / divideNum) : due; // this payment's default amount

  // Every tender the definitions give us, in their sort order, exactly like the iPad's payment bank
  // (Geoff 2026-11-06). The tender's flags pick the pad: cash, room charge, gift/loyalty, else the
  // amount pad — online card tenders go to the processor from there, offline ones post as plain lines.
  const cash = p.tenders.find((t) => t.isCash);
  const cards = p.tenders.filter((t) => t.isCredit && !t.isGift && !t.isLoyalty && !t.isRoomCharge);
  const openTender = (t: Tender) => {
    setMsg("");
    if (t.isCash) setMode({ kind: "cash" });
    else if (t.isRoomCharge) setMode({ kind: "room", tender: t });
    else if (t.isGift || t.isLoyalty) setMode({ kind: "gift", tender: t });
    else setMode({ kind: "card", tender: t });
  };
  const tenderSub = (t: Tender): string | null => (t.isCredit && !t.isOnline && !t.isGift && !t.isLoyalty && !t.isRoomCharge ? "Offline Credit Card" : null);

  const settleNow = async () => {
    setBusy(true); setMsg("Settling…");
    const r = await p.settle();
    setBusy(false);
    if (r.ok) p.onClosed(); else setMsg(r.message);
  };

  /** Record a tender line and step the divide-by count down (divideNum--). */
  const record = (t: Omit<TenderLine, "key">, note: string) => {
    p.applyTender(t);
    if (divideNum > 1) setDivideNum((n) => n - 1);
    setMode({ kind: "tenders" });
    setMsg(note);
  };

  const applyCash = (entered: number) => {
    const applied = round2(Math.min(entered, due));
    const change = round2(Math.max(0, entered - due));
    record({ tenderId: cash!.id, name: cash!.name, amount: applied, tip: 0, change }, change > 0 ? `Change due ${fmt(change)}` : "");
  };

  /** Offline card amount entered: Overpay_Is_Tip turns the excess into the tip,
   *  Ask_For_Tip opens the tip pad, otherwise the payment is recorded as-is. */
  /** Card amount pad OK. An empty pad means "this payment's default" (the share
   *  when divided, else the balance). Above that target: Overpay_Is_Tip turns the
   *  excess into the tip, otherwise it's refused. */
  const cardAmount = (tender: Tender, entered: number) => {
    const target = round2(divideNum > 1 ? share : due);
    const amt = entered > 0 ? round2(entered) : target;
    if (amt <= 0) return;
    if (amt > target + 0.005) {
      if (tender.overpayIsTip) { finishCard(tender, target, round2(amt - target)); return; }
      setMsg(`Amount exceeds the ${divideNum > 1 ? "share" : "balance due"} (${fmt(target)})`); setMode({ kind: "tenders" }); return;
    }
    // An online auth takes no tip now — the tip is entered at finalize (capture); a one-shot sale asks first.
    if (tender.askForTip && (!tender.isOnline || oneShot(tender))) { setMode({ kind: "tip", tender, amount: amt }); return; }
    finishCard(tender, amt, 0);
  };
  const tipPct = p.card?.maxTipPercent ?? 50;
  const finishCard = (tender: Tender, amount: number, tip: number) => {
    setMode({ kind: "tenders" }); // the pads close first — a cancelled tip auth leaves nothing pending
    const post = () => {
      if (tender.isOnline && p.card) { startOnline(tender, amount, tip); return; }
      record({ tenderId: tender.id, name: tender.name, amount, tip, change: 0 },
        tip > 0 ? `${tender.name} ${fmt(amount)} + tip ${fmt(tip)}` : `${tender.name} ${fmt(amount)}`);
    };
    // TIP_AUTH: a tip at/above Max_Tip_Percent of the payment needs a manager; cancelling the auth cancels the payment
    if (tip > 0 && amount > 0 && (tip / amount) * 100 >= tipPct) { setMsg(`${fmt(tip)} tip needs a manager`); p.authorize(`Authorize ${fmt(tip)} tip`, post); }
    else post();
  };

  /* ---------------- Online cards (the processor seam) ---------------- */

  /** One-shot sale (capture now) vs auth-then-capture: the terminal's Pay_At_Table
   *  flag, or a tender flagged auto-capture (tender_backup10). */
  const oneShot = (tender: Tender): boolean => !!p.card && (p.card.payAtTable || tender.autoCapture);

  /** Amount (and tip) settled: every online tender goes to the processor, which drives the payment
   *  device. The POS never takes a card number (Geoff 2026-11-06) — a "keyed" tender is keyed on the device. */
  const startOnline = (tender: Tender, amount: number, tip: number) => { void processOnline(tender, amount, tip); };

  const processOnline = async (tender: Tender, amount: number, tip: number, forceAuth = false) => {
    const card = p.card!;
    const key = card.mintKey();
    const ctx = card.checkRef(key);
    const sale = !forceAuth && oneShot(tender);   // a bar tab is always a hold, whatever the terminal's Pay_At_Table
    const timeoutSec = tender.waitTimeSec > 0 ? tender.waitTimeSec : card.timeoutSec;
    const req = { ...ctx, amount, tip: sale ? tip : undefined, tenderId: tender.id, readerId: card.readerId || undefined, promptTip: sale && tender.askForTip, deviceKeyedEntry: tender.deviceKeyedEntry || undefined, timeoutSec };
    setBusy(true);
    setMode({ kind: "processing", tender, text: "Present the card…" });
    const run = runCard(card.processor, ctx, () => (sale ? card.processor.sale(req) : card.processor.authorize(req)),
      { timeoutSec, onProgress: (r) => setMode({ kind: "processing", tender, text: r.message || "Processing…" }) });
    runRef.current = run.handle;
    const r = await run.done;
    runRef.current = null;
    setBusy(false);
    if (r.status !== "ok") { setMode({ kind: "tenders" }); setMsg(r.status === "cancelled" ? "Card payment cancelled" : `${tender.name}: ${r.message}`); return; }
    const approved = round2(r.authorizedAmount ?? r.capturedAmount ?? amount);
    const partial = approved < amount - 0.005;
    const brandTender = r.brand ? card.brandTender(r.brand) : undefined;
    const line: Omit<TenderLine, "key"> = {
      tenderId: brandTender?.id ?? tender.id, name: brandTender?.name ?? tender.name,
      amount: partial ? approved : amount, tip: sale ? round2(r.tip ?? tip) : 0, change: 0,
      processor: card.processorName, ref: r.ref, recordNo: r.recordNo ?? r.ref, authCode: r.authCode, last4: r.last4, brand: r.brand,
      finalized: sale, authorizedAmount: approved, capturedAmount: sale ? round2((partial ? approved : amount) + round2(r.tip ?? tip)) : undefined,
    };
    const note = `${line.name} ${fmt(line.amount)}${line.tip ? ` + tip ${fmt(line.tip)}` : ""}${line.last4 ? ` ••${line.last4}` : ""}${sale ? "" : " authorized"}${partial ? ` · partial approval (${fmt(approved)} of ${fmt(amount)})` : ""}`;
    recordWithKey(key, line, note);
  };

  /** Record the processed line under the key the processor already knows (idempotency). */
  const recordWithKey = (key: string, line: Omit<TenderLine, "key">, note: string) => {
    p.applyTender({ ...line, key });
    if (divideNum > 1) setDivideNum((n) => n - 1);
    setMode({ kind: "tenders" });
    setMsg(note);
  };

  /** Void an UNSENT tender line. A card line already moved money at the processor (a one-shot sale is
   *  captured, an auth is held), so it is cancelled / refunded there first and only removed locally when
   *  the processor agrees — 2026-11-06: an unsent Amex sale voided on the POS stayed captured on Stripe. */
  const voidUnsent = async (t: TenderLine) => {
    if (t.ref && t.processor && p.card) {
      setBusy(true);
      // A debit payment (tender Is_Debit) goes back with the card present on the reader; any other does when
      // the processor says the refund must be made in person (payments/run undoCard).
      const card = p.card, ref = t.ref, ctx = card.checkRef(t.key);
      const total = round2(Math.abs(t.amount) + Math.abs(t.tip || 0));
      const debit = t.finalized === true && !!p.tenders.find((x) => x.id === t.tenderId)?.isDebit;
      const r: CardResult = await undoCard(card.processor, ref, ctx, async () => {
        let x = await card.processor.cancel(ref, ctx);
        if (x.status === "error" && !x.needsCardPresent && t.finalized) x = await card.processor.refund(ref, total, ctx);
        return x;
      }, {
        timeoutSec: card.timeoutSec, debit, amount: total, readerId: card.readerId || undefined,
        onPresent: (h, amt) => { runRef.current = h; setMode({ kind: "refunding", title: `${t.name} refund`, text: `Present the same card on the reader to refund ${fmt(amt)}` }); },
      });
      runRef.current = null;
      setMode({ kind: "tenders" });
      setBusy(false);
      if (r.status !== "ok" && r.status !== "cancelled") { setMsg(`${t.name} void failed: ${r.message}`); return; }
      p.voidTender(t.key); setMsg(`${t.name} voided — ${r.message}`); return;
    }
    p.voidTender(t.key); setMsg(`${t.name} voided`);
  };

  /* ---------------- Bar tabs (Terminal "Bar Tabs") ---------------- */
  const hold = openHold(p.check);
  /** The tender a tab opens on: the one flagged for incremental auth, else the plain online credit tender (Auth CC). */
  const tabTender = p.tenders.find((t) => t.isOnline && t.incrementalAuth)
    ?? p.tenders.find((t) => t.isOnline && t.isCredit && !t.deviceKeyedEntry && !t.autoCapture)
    ?? p.tenders.find((t) => t.isOnline && t.isCredit);
  const openTab = () => {
    if (!tabTender) { setMsg("No online card tender to open a tab on"); return; }
    if (due <= 0.005) { setMsg("Add the first round before opening a tab"); return; }
    setMsg(""); void processOnline(tabTender, due, 0, true);
  };
  const finishTab = async (line: TenderLine, tip: number) => {
    const card = p.card!;
    const run = async () => {
      setBusy(true); setMode({ kind: "tenders" }); setMsg(`Finishing tab — capturing ${fmt(round2(line.amount + tip))}…`);
      const r = await card.finishTab!(line.key, tip);
      setBusy(false);
      if (!r.ok) { setMsg(`Finish tab failed: ${r.message}`); return; }
      // The hold is captured for what it covered; anything the check grew past it stays due and is
      // paid like any other balance (partial payment). The check closes only when nothing is owed.
      const stillDue = round2(due);
      if (stillDue > 0.005) { setMsg(`Tab captured · ${fmt(line.amount)} + tip ${fmt(tip)} · ${fmt(stillDue)} still due`); return; }
      setMsg(`Tab finished · ${fmt(line.amount)} + tip ${fmt(tip)}`);
      await settleNow();
    };
    if (tip > 0 && line.amount > 0 && (tip / line.amount) * 100 >= tipPct) { setMsg(`${fmt(tip)} tip needs a manager`); p.authorize(`Authorize ${fmt(tip)} tip`, () => void run()); }
    else await run();
  };
  const voidTab = (line: TenderLine) => { if (line.sent) p.voidPostedTender?.(line.key); else void voidUnsent(line); };

  /** A posted card line that no longer matches the check: over-tendered after a void
   *  (shrink), or still owing with an open auth (grow). */
  const cardLines = p.check.tenders.filter((t) => isCardLine(t) && t.sent);
  const surplus = round2(paid - total);
  const fitLine = cardLines.length === 1 ? cardLines[0] : undefined;
  const canShrink = !!p.card?.resize && !!fitLine && surplus > 0.005 && fitLine.amount - surplus > 0.005;
  const canGrow = !!p.card?.resize && !!fitLine && due > 0.005 && isUncapturedCard(fitLine);
  const resizeTo = async (line: TenderLine, amount: number) => {
    setBusy(true); setMsg(`Adjusting ${line.name} to ${fmt(amount)}…`);
    const r = await p.card!.resize!(line.key, amount);
    setBusy(false); setMsg(r.ok ? `${line.name} is now ${fmt(amount)}` : `Adjust failed: ${r.message}`);
  };


  return (
    <div className="backdrop" onClick={busy ? undefined : p.onClose}>
      <div className="payview" onClick={(e) => e.stopPropagation()}>
        <div className="pvhead">
          <div>
            <div className="pvtitle">{due <= 0.005 ? "Balance Paid" : "Balance Due"}</div>
            <div className="pvbal">{fmt(due)}</div>
            <div className="pvsub">Subtotal {fmt(subtotal)} · tax {fmt(p.tax.taxTotal)} · total {fmt(total)} · paid {fmt(paid)}</div>
          </div>
          <button className="x" onClick={p.onClose} disabled={busy}>✕</button>
        </div>

        {/* Applied tenders — an unsent one is removed; a POSTED one (pulled-back check) is voided with a reversal, cash or card alike */}
        {p.check.tenders.some((t) => !t.isVoid) && (
          <div className="pvtenders">
            {p.check.tenders.filter((t) => !t.isVoid).map((t) => (
              <div key={t.key} className="pvtl">
                <span>{t.name}{t.last4 ? ` ••${t.last4}` : ""}{t.reference ? ` · ${t.reference}` : ""}{t.tip ? ` · tip ${fmt(t.tip)}` : ""}{t.finalized === false ? " · auth" : ""}</span>
                <span>
                  {fmt(t.amount)}{t.change ? ` (chg ${fmt(t.change)})` : ""}
                  {!t.sent && <button className="pvvoid" disabled={busy} onClick={() => void voidUnsent(t)}>Void</button>}
                  {t.sent && p.voidPostedTender && <button className="pvvoid" disabled={busy} onClick={() => p.voidPostedTender!(t.key)}>Void</button>}
                </span>
              </div>
            ))}
          </div>
        )}

        {msg && <div className="pvmsg">{msg}</div>}

        {mode.kind === "tenders" && (
          <>
            {due <= 0.005 ? (
              <>
                {p.card?.barTabs && hold && (
                  <div className="pvtab">
                    <span className="pvtabinfo">Tab · {hold.name}{hold.last4 ? ` ••${hold.last4}` : ""} · {fmt(hold.amount)} held</span>
                    <button className="mfbtn go" disabled={busy || !p.card.finishTab} onClick={() => { setMsg(""); setMode({ kind: "tabtip", line: hold }); }}>Finish Tab</button>
                    <button className="mfbtn ghost" disabled={busy} onClick={() => voidTab(hold)}>Void Tab</button>
                  </div>
                )}
                <button className="pvsettle" onClick={settleNow} disabled={busy}>{busy ? "Settling…" : "Close check"}</button>
              </>
            ) : (
              <>
                {p.card?.barTabs && (
                  <div className="pvtab">
                    {hold ? (
                      <>
                        <span className="pvtabinfo">Tab · {hold.name}{hold.last4 ? ` ••${hold.last4}` : ""} · {fmt(hold.amount)} held{due > 0.005 ? ` · ${fmt(due)} not yet held` : ""}</span>
                        <button className="mfbtn go" disabled={busy || !p.card.finishTab} onClick={() => { setMsg(""); setMode({ kind: "tabtip", line: hold }); }}>Finish Tab</button>
                        <button className="mfbtn ghost" disabled={busy} onClick={() => voidTab(hold)}>Void Tab</button>
                      </>
                    ) : (
                      <button className="mfbtn go" disabled={busy || due <= 0.005 || !tabTender} onClick={openTab}>Open Tab · hold {fmt(due)}</button>
                    )}
                  </div>
                )}
                <div className="pvgrid">
                  {p.tenders.map((t) => t.isOnline && !p.card
                    ? <button key={t.id} className="pvbtn disabled" disabled title="No card processor is configured for this store">{t.name}</button>
                    : <button key={t.id} className="pvbtn" onClick={() => openTender(t)}>{t.name}{tenderSub(t) ? <small className="pvsub">{tenderSub(t)}</small> : null}</button>)}
                </div>
                {canGrow && fitLine && <button className="pvfit" disabled={busy} onClick={() => void resizeTo(fitLine, round2(fitLine.amount + due))}>Increase {fitLine.name} auth to {fmt(round2(fitLine.amount + due))}</button>}
                <div className="pvdivide">
                  <span>{divideNum > 1 ? `Divided ${divideNum} ways · ${fmt(share)} each` : "Divide the balance evenly"}</span>
                  <button onClick={() => setMode({ kind: "divide" })}>Divide By</button>
                </div>
              </>
            )}
            {canShrink && fitLine && due <= 0.005 && <button className="pvfit" disabled={busy} onClick={() => void resizeTo(fitLine, round2(fitLine.amount - surplus))}>Reduce {fitLine.name} to {fmt(round2(fitLine.amount - surplus))} (check is over-tendered by {fmt(surplus)})</button>}
            {cards.some((t) => t.isOnline) && !p.card && due > 0.005 && <div className="pvnote">Online card tenders are disabled — no card processor is configured for this store.</div>}
          </>
        )}

        {mode.kind === "cash" && cash && <CashPad due={share} rounding={cash.roundingAmount} onApply={applyCash} onBack={() => setMode({ kind: "tenders" })} />}

        {mode.kind === "card" && (
          <NumberPad key="card" title={mode.tender.name} sub={`Amount — OK alone pays ${fmt(share)}${divideNum > 1 ? ` (share of ${fmt(due)})` : ""}`} mode="money"
            onOk={(v) => cardAmount(mode.tender, v)} onCancel={() => setMode({ kind: "tenders" })} />
        )}
        {mode.kind === "tip" && (
          <NumberPad key={`tip-${mode.amount}`} title="Tip" sub={`${mode.tender.name} ${fmt(mode.amount)} — enter the tip (OK alone = no tip)`} mode="money"
            onOk={(v) => finishCard(mode.tender, mode.amount, round2(v))} onCancel={() => setMode({ kind: "tenders" })} />
        )}
        {mode.kind === "divide" && (
          <NumberPad title="Divide By" sub={`Split ${fmt(due)} into how many payments?`} mode="count" initial={divideNum > 1 ? String(divideNum) : ""}
            onOk={(n) => { setDivideNum(Math.max(1, Math.floor(n))); setMode({ kind: "tenders" }); setMsg(n > 1 ? `Divided ${Math.floor(n)} ways · ${fmt(round2(due / Math.floor(n)))} each` : ""); }}
            onCancel={() => setMode({ kind: "tenders" })} />
        )}

        {mode.kind === "tabtip" && (
          <NumberPad key={`tabtip-${mode.line.key}`} title="Finish Tab — tip" sub={`${mode.line.name} ${fmt(mode.line.amount)} held — enter the tip (OK alone = no tip), then the card is captured and the check closed`} mode="money"
            onOk={(v) => void finishTab(mode.line, round2(v))} onCancel={() => setMode({ kind: "tenders" })} />
        )}
        {mode.kind === "refunding" && (
          <div className="pvprocessing">
            <div className="pvspin" />
            <div className="pvtitle">{mode.title}</div>
            <div className="pvproctext">{mode.text}</div>
            <div className="pvactions"><button className="mfbtn ghost" onClick={() => runRef.current?.cancel()}>Cancel</button></div>
          </div>
        )}
        {mode.kind === "processing" && (
          <div className="pvprocessing">
            <div className="pvspin" />
            <div className="pvtitle">{mode.tender.name}</div>
            <div className="pvproctext">{mode.text}</div>
            <div className="pvactions"><button className="mfbtn ghost" onClick={() => runRef.current?.cancel()}>Cancel</button></div>
          </div>
        )}

        {mode.kind === "room" && (
          <RoomCharge due={share} tenderName={mode.tender.name}
            onApply={(room, name, amount) => {
              const a = round2(Math.min(amount, due));
              record({ tenderId: mode.tender.id, name: mode.tender.name, amount: a, tip: 0, change: 0, reference: `Room ${room}${name ? ` ${name}` : ""}` }, `Charged ${fmt(a)} to room ${room}`);
            }}
            onBack={() => setMode({ kind: "tenders" })} />
        )}

        {mode.kind === "gift" && (
          <GiftPay due={share} tender={mode.tender} busy={busy}
            onBalance={async (card) => { setBusy(true); const r = await p.processGift(card, mode.tender.isLoyalty ? "LoyaltyBalance" : "PrePaidBalance", 0); setBusy(false); return r; }}
            onRedeem={async (card, amount, balanceRef) => {
              setBusy(true);
              const r = await p.processGift(card, mode.tender.isLoyalty ? "LoyaltyRedeem" : "PrePaidSale", amount);
              setBusy(false);
              if (r.ok) record({ tenderId: mode.tender.id, name: mode.tender.name, amount: round2(amount), tip: 0, change: 0, reference: card.slice(-4), balanceRef: r.balance ?? balanceRef },
                `${mode.tender.name} applied${r.balance ? ` · balance ${r.balance}` : ""}`);
              else setMsg(r.message);
            }}
            onBack={() => setMode({ kind: "tenders" })} />
        )}
      </div>
    </div>
  );
}

function CashPad({ due, rounding, onApply, onBack }: { due: number; rounding: string; onApply: (n: number) => void; onBack: () => void }) {
  const [entry, setEntry] = useState("");
  const val = Number(entry) || 0;
  const quick = [round2(due), 20, 50, 100].filter((v, i, a) => a.indexOf(v) === i && v >= due || v === round2(due));
  const key = (k: string) => setEntry((e) => (k === "." && e.includes(".") ? e : (e + k).slice(0, 8)));
  return (
    <div className="cashpad">
      <div className="cashrow">
        <input className="cashin" value={entry} onChange={(e) => setEntry(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={fmt(due)} inputMode="decimal" />
        {rounding && <span className="pvnote">rounds to {rounding}</span>}
      </div>
      <div className="quickrow">
        {quick.map((q) => <button key={q} className="qbtn" onClick={() => onApply(q)}>{q === round2(due) ? `Exact ${fmt(q)}` : fmt(q)}</button>)}
      </div>
      <div className="keypad">
        {["1","2","3","4","5","6","7","8","9",".","0","⌫"].map((k) => (
          <button key={k} className="kkey" onClick={() => (k === "⌫" ? setEntry((e) => e.slice(0, -1)) : key(k))}>{k}</button>
        ))}
      </div>
      <div className="pvactions">
        <button className="mfbtn ghost" onClick={onBack}>Back</button>
        <button className="mfbtn go" disabled={val <= 0} onClick={() => onApply(val)}>Apply {val > 0 ? fmt(val) : ""}</button>
      </div>
    </div>
  );
}

function RoomCharge({ due, tenderName, onApply, onBack }: { due: number; tenderName: string; onApply: (room: string, name: string, amount: number) => void; onBack: () => void }) {
  const [room, setRoom] = useState("");
  const [name, setName] = useState("");
  return (
    <div className="roompad">
      <label>Room number<input value={room} onChange={(e) => setRoom(e.target.value)} inputMode="numeric" autoFocus /></label>
      <label>Guest last name (optional)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <p className="pvnote">{tenderName} — recorded offline against the room.</p>
      <div className="pvactions">
        <button className="mfbtn ghost" onClick={onBack}>Back</button>
        <button className="mfbtn go" disabled={!room.trim()} onClick={() => onApply(room.trim(), name.trim(), due)}>Charge {fmt(due)}</button>
      </div>
    </div>
  );
}

function GiftPay({ due, tender, busy, onBalance, onRedeem, onBack }: {
  due: number; tender: Tender; busy: boolean;
  onBalance: (card: string) => Promise<PaymentResult>;
  onRedeem: (card: string, amount: number, balanceRef?: string) => void;
  onBack: () => void;
}) {
  const [card, setCard] = useState("");
  const [balance, setBalance] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [err, setErr] = useState("");
  const bal = balance != null ? Number(balance) || 0 : null;
  const redeemAmt = amount ? Number(amount) : Math.min(due, bal ?? due);
  return (
    <div className="roompad">
      <label>{tender.isLoyalty ? "Member / loyalty card" : "Gift card number"}
        <input value={card} onChange={(e) => { setCard(e.target.value.replace(/\s/g, "")); setErr(""); }} inputMode="numeric" autoFocus />
      </label>
      {err && <p className="pvmsg">{err}</p>}
      {balance != null && <p className="pvnote">Balance: {balance}</p>}
      {balance != null && (
        <label>Redeem amount<input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={fmt(Math.min(due, bal ?? due))} inputMode="decimal" /></label>
      )}
      <div className="pvactions">
        <button className="mfbtn ghost" onClick={onBack} disabled={busy}>Back</button>
        {balance == null ? (
          <button className="mfbtn go" disabled={busy || !card.trim()} onClick={async () => { setErr(""); const r = await onBalance(card.trim()); if (r.ok) setBalance(r.balance ?? "0"); else setErr(r.message); }}>{busy ? "Checking…" : "Check balance"}</button>
        ) : (
          <button className="mfbtn go" disabled={busy || redeemAmt <= 0} onClick={() => onRedeem(card.trim(), round2(Math.min(redeemAmt, due)), balance ?? undefined)}>{busy ? "Processing…" : `Redeem ${fmt(Math.min(redeemAmt, due))}`}</button>
        )}
      </div>
    </div>
  );
}

