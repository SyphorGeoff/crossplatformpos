/*
 * Payment view — settle the check. Tenders are classified from the Tender
 * definition (cash / room-charge / native gift / native loyalty / credit).
 * Cash takes an amount and returns change; native gift does a balance inquiry
 * then redeem via <Payment> to HBroker; room charge records offline against a
 * room number. Credit tenders that are NOT Is_Online are offline "dummy"
 * payments (makePayment: no processor → a plain Type="T" line); online card
 * processing is still deferred. When the balance reaches zero the check is
 * settled (the FinancialCheck re-POST with Is_Closed/Is_Settled).
 *
 * Tips (CheckViewController tips block :3240+): Ask_For_Tip → tip pad after the
 * amount; Overpay_Is_Tip → anything above the balance is the tip; a tip of 50%
 * or more of the balance needs a manager (TIP_AUTH). Divide By (DIVIDE_BY):
 * a count pad sets N; each payment defaults to balance ÷ N and N steps down
 * with every payment until the check closes.
 */

import { useState } from "react";
import { checkSubtotal, tenderApplied, type Check, type TenderLine } from "@/model/check";
import { balanceWithTax, grandTotal, type TaxResult } from "@/model/tax";
import type { Tender } from "@/model/catalog";
import type { GiftType, LoyaltyType, PaymentResult } from "@/protocol/payment";
import NumberPad from "./NumberPad";

const fmt = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const round2 = (n: number) => Math.round(n * 100) / 100;

type Mode = { kind: "tenders" } | { kind: "cash" } | { kind: "gift"; tender: Tender } | { kind: "room"; tender: Tender }
  | { kind: "card"; tender: Tender } | { kind: "tip"; tender: Tender; amount: number } | { kind: "divide" };

export interface PaymentViewProps {
  check: Check;
  tax: TaxResult;
  tenders: Tender[];
  applyTender: (t: Omit<TenderLine, "key">) => void;
  voidTender: (key: string) => void;                 // unsent tender: just removed
  voidPostedTender?: (key: string) => void;          // posted tender: void auth + reason, reversal posted
  processGift: (card: string, type: GiftType | LoyaltyType, amount: number) => Promise<PaymentResult>;
  settle: () => Promise<{ ok: boolean; message: string }>;
  /** Manager authorization (TIP_AUTH) — runs onOk once an authorizer is confirmed. */
  authorize: (title: string, onOk: () => void) => void;
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
  const [divideNum, setDivideNum] = useState(1);   // DIVIDE_BY — ways left to split the balance
  const share = divideNum > 1 ? round2(due / divideNum) : due; // this payment's default amount

  const cash = p.tenders.find((t) => t.isCash);
  const rooms = p.tenders.filter((t) => t.isRoomCharge);
  const gifts = p.tenders.filter((t) => t.isGift || t.isLoyalty);
  const cards = p.tenders.filter((t) => t.isCredit && !t.isGift && !t.isLoyalty && !t.isRoomCharge);

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
    if (tender.askForTip) { setMode({ kind: "tip", tender, amount: amt }); return; }
    finishCard(tender, amt, 0);
  };
  const finishCard = (tender: Tender, amount: number, tip: number) => {
    setMode({ kind: "tenders" }); // the pads close first — a cancelled tip auth leaves nothing pending
    const post = () => record({ tenderId: tender.id, name: tender.name, amount, tip, change: 0 },
      tip > 0 ? `${tender.name} ${fmt(amount)} + tip ${fmt(tip)}` : `${tender.name} ${fmt(amount)}`);
    // TIP_AUTH: a tip of half the payment or more needs a manager; cancelling the auth cancels the payment
    if (tip > 0 && amount > 0 && tip / amount >= 0.5) { setMsg(`${fmt(tip)} tip needs a manager`); p.authorize(`Authorize ${fmt(tip)} tip`, post); }
    else post();
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
                <span>{t.name}{t.reference ? ` · ${t.reference}` : ""}{t.tip ? ` · tip ${fmt(t.tip)}` : ""}</span>
                <span>
                  {fmt(t.amount)}{t.change ? ` (chg ${fmt(t.change)})` : ""}
                  {!t.sent && <button className="pvvoid" disabled={busy} onClick={() => { p.voidTender(t.key); setMsg(`${t.name} voided`); }}>Void</button>}
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
              <button className="pvsettle" onClick={settleNow} disabled={busy}>{busy ? "Settling…" : "Close check"}</button>
            ) : (
              <>
                <div className="pvgrid">
                  {cash && <button className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "cash" }); }}>Cash</button>}
                  {rooms.map((t) => <button key={t.id} className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "room", tender: t }); }}>{t.name}</button>)}
                  {gifts.map((t) => <button key={t.id} className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "gift", tender: t }); }}>{t.name}</button>)}
                  {cards.map((t) => t.isOnline
                    ? <button key={t.id} className="pvbtn disabled" disabled title="Online card processing — coming soon">{t.name}</button>
                    : <button key={t.id} className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "card", tender: t }); }}>{t.name}</button>)}
                </div>
                <div className="pvdivide">
                  <span>{divideNum > 1 ? `Divided ${divideNum} ways · ${fmt(share)} each` : "Divide the balance evenly"}</span>
                  <button onClick={() => setMode({ kind: "divide" })}>Divide By</button>
                </div>
              </>
            )}
            {cards.some((t) => t.isOnline) && due > 0.005 && <div className="pvnote">Online card tenders are disabled — card processing arrives later.</div>}
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
