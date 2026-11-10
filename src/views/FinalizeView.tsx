/*
 * Finalize credit tenders (CreditCardFinalizeViewController): the business
 * date's authorized-but-uncaptured card lines on settled checks. A server sees
 * their own; a manager / FINALIZE_CREDIT job sees everyone's. Pick a line, enter
 * the tip (presets from the tender's tip1..tip3, or a custom amount), and the
 * parent captures base + tip at the processor, then posts Finalize_Tender.
 * A tip at/above Store Max_Tip_Percent of the base needs TIP_AUTH first.
 */

import { useEffect, useState } from "react";
import type { UnfinalizedTender } from "@/protocol/finalize";
import NumberPad from "./NumberPad";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface FinalizeViewProps {
  load: () => Promise<UnfinalizedTender[]>;
  empPosId: string;
  canAll: boolean;                                   // manager or FINALIZE_CREDIT: list every employee's tenders
  tenderName: (id: string) => string;
  employeeName: (id: string) => string;
  tipPresets: (tenderId: string) => number[];        // percent presets for that tender
  maxTipPercent: number;                             // TIP_AUTH threshold (Store Max_Tip_Percent)
  finalize: (row: UnfinalizedTender, tip: number, authEmpId?: string) => Promise<{ ok: boolean; message: string }>;
  authorize: (title: string, onOk: (authEmpId: string) => void) => void;
  onClose: () => void;
}

export default function FinalizeView(p: FinalizeViewProps) {
  const [rows, setRows] = useState<UnfinalizedTender[] | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<UnfinalizedTender | null>(null);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = async () => {
    setErr("");
    try { const all = await p.load(); setRows(p.canAll ? all : all.filter((r) => r.empPosId === p.empPosId)); }
    catch (e) { setRows([]); setErr(String((e as Error).message ?? e)); }
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = async (row: UnfinalizedTender, tip: number) => {
    const run = async (authEmpId?: string) => {
      setBusy(true); setMsg(`Capturing ${fmt(round2(row.baseAmount + tip))}…`);
      const r = await p.finalize(row, tip, authEmpId);
      setBusy(false); setPick(null); setCustom(false);
      setMsg(r.ok ? `Check ${row.checkNo} finalized · ${fmt(row.baseAmount)} + tip ${fmt(tip)}` : `Finalize failed: ${r.message}`);
      if (r.ok) void refresh();
    };
    if (tip > 0 && row.baseAmount > 0 && (tip / row.baseAmount) * 100 >= p.maxTipPercent) {
      setMsg(`${fmt(tip)} tip needs a manager`);
      p.authorize(`Authorize ${fmt(tip)} tip`, (authEmpId) => void run(authEmpId));
      return;
    }
    await run(row.empPosId !== p.empPosId ? p.empPosId : undefined);
  };

  return (
    <div className="backdrop" onClick={busy ? undefined : p.onClose}>
      <div className="payview finview" onClick={(e) => e.stopPropagation()}>
        <div className="pvhead">
          <div>
            <div className="pvtitle">Finalize credit tenders</div>
            <div className="pvsub">{p.canAll ? "All employees" : "Your tenders"} · settled checks awaiting a tip and capture</div>
          </div>
          <button className="x" onClick={p.onClose} disabled={busy}>✕</button>
        </div>
        {msg && <div className="pvmsg">{msg}</div>}
        {err && <div className="pvmsg">{err}</div>}

        {!pick && (
          rows == null ? <div className="pvnote">Loading…</div>
          : rows.length === 0 ? <div className="pvnote">Nothing to finalize.</div>
          : <div className="finlist">
              {rows.map((r) => (
                <button key={`${r.checkNo}:${r.trayNumber}:${r.lineNumber}`} className="finrow" disabled={busy} onClick={() => { setMsg(""); setPick(r); }}>
                  <span className="finchk">#{r.checkNo}{r.checkName ? ` · ${r.checkName}` : ""}</span>
                  <span className="finwho">{p.employeeName(r.empPosId)}</span>
                  <span className="fincard">{p.tenderName(r.tenderId)}{r.last4 ? ` ••${r.last4}` : ""}</span>
                  <span className="finamt">{fmt(r.baseAmount)}</span>
                </button>
              ))}
            </div>
        )}

        {pick && !custom && (
          <div className="roompad">
            <div className="pvtitle">Check #{pick.checkNo} · {p.tenderName(pick.tenderId)}{pick.last4 ? ` ••${pick.last4}` : ""} · {fmt(pick.baseAmount)}</div>
            <div className="pvnote">Tip, then capture {fmt(pick.baseAmount)} + tip.</div>
            <div className="quickrow">
              {p.tipPresets(pick.tenderId).map((pct) => {
                const tip = round2(pick.baseAmount * pct / 100);
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
          <NumberPad key={`fin-${pick.checkNo}`} title="Tip" sub={`Check #${pick.checkNo} · ${fmt(pick.baseAmount)} — enter the tip (OK alone = no tip)`} mode="money"
            onOk={(v) => void commit(pick, round2(v))} onCancel={() => setCustom(false)} />
        )}
      </div>
    </div>
  );
}
