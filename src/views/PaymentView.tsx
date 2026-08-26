/*
 * Payment view — settle the check. Tenders are classified from the Tender
 * definition (cash / room-charge / native gift / native loyalty / credit).
 * Cash takes an amount and returns change; native gift does a balance inquiry
 * then redeem via <Payment> to HBroker; room charge records offline against a
 * room number; credit cards are stubbed (deferred). When the balance reaches
 * zero the check is settled (the FinancialCheck re-POST with Is_Closed/Is_Settled).
 *
 * Balance due is the subtotal — tax is not yet computed (a separate subsystem).
 */

import { useState } from "react";
import { balanceDue, checkSubtotal, tenderApplied, type Check, type TenderLine } from "@/model/check";
import type { Tender } from "@/model/catalog";
import type { GiftType, LoyaltyType, PaymentResult } from "@/protocol/payment";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Mode = { kind: "tenders" } | { kind: "cash" } | { kind: "gift"; tender: Tender } | { kind: "room"; tender: Tender };

export interface PaymentViewProps {
  check: Check;
  tenders: Tender[];
  applyTender: (t: Omit<TenderLine, "key">) => void;
  processGift: (card: string, type: GiftType | LoyaltyType, amount: number) => Promise<PaymentResult>;
  settle: () => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
  onClosed: () => void;
}

export default function PaymentView(p: PaymentViewProps) {
  const due = balanceDue(p.check);
  const paid = tenderApplied(p.check);
  const [mode, setMode] = useState<Mode>({ kind: "tenders" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const cash = p.tenders.find((t) => t.isCash);
  const rooms = p.tenders.filter((t) => t.isRoomCharge);
  const gifts = p.tenders.filter((t) => t.isGift || t.isLoyalty);
  const cards = p.tenders.filter((t) => t.isCredit);

  const settleNow = async () => {
    setBusy(true); setMsg("Settling…");
    const r = await p.settle();
    setBusy(false);
    if (r.ok) p.onClosed(); else setMsg(r.message);
  };

  const applyCash = (entered: number) => {
    const applied = round2(Math.min(entered, due));
    const change = round2(Math.max(0, entered - due));
    p.applyTender({ tenderId: cash!.id, name: cash!.name, amount: applied, tip: 0, change });
    setMode({ kind: "tenders" });
    setMsg(change > 0 ? `Change due ${fmt(change)}` : "");
  };

  return (
    <div className="backdrop" onClick={busy ? undefined : p.onClose}>
      <div className="payview" onClick={(e) => e.stopPropagation()}>
        <div className="pvhead">
          <div>
            <div className="pvtitle">{due <= 0.005 ? "Balance Paid" : "Balance Due"}</div>
            <div className="pvbal">{fmt(due)}</div>
            <div className="pvsub">Subtotal {fmt(checkSubtotal(p.check))} · paid {fmt(paid)} · tax not incl.</div>
          </div>
          <button className="x" onClick={p.onClose} disabled={busy}>✕</button>
        </div>

        {/* Applied tenders */}
        {p.check.tenders.length > 0 && (
          <div className="pvtenders">
            {p.check.tenders.map((t) => (
              <div key={t.key} className="pvtl">
                <span>{t.name}{t.reference ? ` · ${t.reference}` : ""}</span>
                <span>{fmt(t.amount)}{t.change ? ` (chg ${fmt(t.change)})` : ""}</span>
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
              <div className="pvgrid">
                {cash && <button className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "cash" }); }}>Cash</button>}
                {rooms.map((t) => <button key={t.id} className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "room", tender: t }); }}>{t.name}</button>)}
                {gifts.map((t) => <button key={t.id} className="pvbtn" onClick={() => { setMsg(""); setMode({ kind: "gift", tender: t }); }}>{t.name}</button>)}
                {cards.map((t) => <button key={t.id} className="pvbtn disabled" disabled title="Card processing — coming soon">{t.name}</button>)}
              </div>
            )}
            {cards.length > 0 && due > 0.005 && <div className="pvnote">Card tenders are disabled — credit-card processing arrives later.</div>}
          </>
        )}

        {mode.kind === "cash" && cash && <CashPad due={due} rounding={cash.roundingAmount} onApply={applyCash} onBack={() => setMode({ kind: "tenders" })} />}

        {mode.kind === "room" && (
          <RoomCharge due={due} tenderName={mode.tender.name}
            onApply={(room, name, amount) => {
              p.applyTender({ tenderId: mode.tender.id, name: mode.tender.name, amount: round2(Math.min(amount, due)), tip: 0, change: 0, reference: `Room ${room}${name ? ` ${name}` : ""}` });
              setMode({ kind: "tenders" }); setMsg(`Charged ${fmt(Math.min(amount, due))} to room ${room}`);
            }}
            onBack={() => setMode({ kind: "tenders" })} />
        )}

        {mode.kind === "gift" && (
          <GiftPay due={due} tender={mode.tender} busy={busy}
            onBalance={async (card) => { setBusy(true); const r = await p.processGift(card, mode.tender.isLoyalty ? "LoyaltyBalance" : "PrePaidBalance", 0); setBusy(false); return r; }}
            onRedeem={async (card, amount, balanceRef) => {
              setBusy(true);
              const r = await p.processGift(card, mode.tender.isLoyalty ? "LoyaltyRedeem" : "PrePaidSale", amount);
              setBusy(false);
              if (r.ok) {
                p.applyTender({ tenderId: mode.tender.id, name: mode.tender.name, amount: round2(amount), tip: 0, change: 0, reference: card.slice(-4), balanceRef: r.balance ?? balanceRef });
                setMode({ kind: "tenders" }); setMsg(`${mode.tender.name} applied${r.balance ? ` · balance ${r.balance}` : ""}`);
              } else setMsg(r.message);
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
