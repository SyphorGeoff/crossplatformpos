/*
 * Edit Payment (Edit Check → Edit Payment): change the tip on a card line the
 * check already carries. The parent runs the processor's `adjust` — TSYS takes
 * a tip either way (TipAdjustment); Stripe only goes down (a refund of the
 * difference) and refuses an increase, which is shown as the processor said it.
 * A tip at/above Store Max_Tip_Percent of the amount, or any change on a
 * finalized line, asks for a manager first. Presentation only.
 */

import { useState } from "react";
import type { TenderLine } from "@/model/check";
import NumberPad from "./NumberPad";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface EditPaymentViewProps {
  lines: TenderLine[];                               // the check's card lines (not voided)
  tipPresets: (tenderId: string) => number[];        // percent presets for that tender
  maxTipPercent: number;                             // TIP_AUTH threshold (Store Max_Tip_Percent)
  adjust: (key: string, tip: number, authEmpId?: string) => Promise<{ ok: boolean; message: string }>;
  authorize: (title: string, onOk: (authEmpId: string) => void) => void;
  onClose: () => void;
}

export default function EditPaymentView(p: EditPaymentViewProps) {
  const [pick, setPick] = useState<TenderLine | null>(null);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const commit = async (line: TenderLine, tip: number) => {
    const run = async (authEmpId?: string) => {
      setBusy(true); setCustom(false); setMsg(`Changing ${line.name} tip to ${fmt(tip)}…`);
      const r = await p.adjust(line.key, tip, authEmpId);
      setBusy(false);
      if (!r.ok) { setMsg(`Not changed: ${r.message}`); return; }
      setMsg(`${line.name}${line.last4 ? ` ••${line.last4}` : ""} tip is now ${fmt(tip)}`);
      setPick(null);
    };
    const bigTip = tip > 0 && line.amount > 0 && (tip / line.amount) * 100 >= p.maxTipPercent;
    if (bigTip || line.finalized) p.authorize(line.finalized ? `Authorize tip change on a finalized card` : `Authorize ${fmt(tip)} tip`, (id) => void run(id));
    else await run();
  };

  return (
    <div className="backdrop" onClick={busy ? undefined : p.onClose}>
      <div className="payview finview" onClick={(e) => e.stopPropagation()}>
        <div className="pvhead">
          <div>
            <div className="pvtitle">Edit payment</div>
            <div className="pvsub">Change the tip on a card already taken</div>
          </div>
          <button className="x" onClick={p.onClose} disabled={busy}>✕</button>
        </div>
        {msg && <div className="pvmsg">{msg}</div>}

        {!pick && (
          p.lines.length === 0 ? <div className="pvnote">No card payments on this check.</div>
          : <div className="finlist">
              {p.lines.map((l) => (
                <button key={l.key} className="finrow" disabled={busy} onClick={() => { setMsg(""); setPick(l); }}>
                  <span className="finchk">{l.name}{l.last4 ? ` ••${l.last4}` : ""}</span>
                  <span className="finwho">{l.finalized === false ? "authorized" : l.finalized ? "captured" : ""}</span>
                  <span className="fincard">tip {fmt(l.tip || 0)}</span>
                  <span className="finamt">{fmt(l.amount)}</span>
                </button>
              ))}
            </div>
        )}

        {pick && !custom && (
          <div className="roompad">
            <div className="pvtitle">{pick.name}{pick.last4 ? ` ••${pick.last4}` : ""} · {fmt(pick.amount)} · tip {fmt(pick.tip || 0)}</div>
            <div className="pvnote">{pick.finalized ? "Captured: the processor decides what it allows — a lower tip is refunded; Stripe does not increase a captured payment." : "Authorized, not yet captured: the tip is captured with the base at finalize."}</div>
            <div className="quickrow">
              {p.tipPresets(pick.tenderId).map((pct) => {
                const tip = round2(pick.amount * pct / 100);
                return <button key={pct} className="qbtn" disabled={busy} onClick={() => void commit(pick, tip)}>{pct}% · {fmt(tip)}</button>;
              })}
              <button className="qbtn" disabled={busy} onClick={() => void commit(pick, 0)}>No tip</button>
              <button className="qbtn" disabled={busy} onClick={() => setCustom(true)}>Custom…</button>
            </div>
            <div className="pvactions">
              <button className="mfbtn ghost" disabled={busy} onClick={() => setPick(null)}>Back</button>
            </div>
          </div>
        )}
        {pick && custom && (
          <NumberPad key={`ep-${pick.key}`} title="Tip" sub={`${pick.name} ${fmt(pick.amount)} — enter the new tip (OK alone = no tip)`} mode="money"
            onOk={(v) => void commit(pick, round2(v))} onCancel={() => setCustom(false)} />
        )}
      </div>
    </div>
  );
}
