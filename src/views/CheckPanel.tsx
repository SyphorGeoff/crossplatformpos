/*
 * Check panel — the running order the server is building, beside the menu grid.
 * Renders the check's line items (modifiers indented under their parent), a
 * table/guest header, a running subtotal/tax/total, Send, Pay, and a Split mode
 * (select item lines → move them to a new check). Presentation only; all
 * mutation goes through useCheck / the Menu orchestration.
 */

import { useState } from "react";
import { checkSubtotal, lineExtended, unsentLines, type Check, type CheckLine } from "@/model/check";
import { grandTotal, type TaxResult } from "@/model/tax";

const fmt = (n: number): string => `$${n.toFixed(2)}`;

export interface CheckPanelProps {
  check: Check;
  tax: TaxResult;
  revenueCenterName: string;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onSetTable: (name: string) => void;
  onSetGuests: (n: number) => void;
  onSend: () => void;
  onPay: () => void;
  onSplit: (keys: Set<string>) => void;
  onNewCheck: () => void;
  sending?: boolean;
  sendError?: string;
}

function LineRow({ line, selecting, checked, onToggle, onQty, onRemove }: {
  line: CheckLine; selecting: boolean; checked: boolean; onToggle: (k: string) => void;
  onQty: CheckPanelProps["onQty"]; onRemove: CheckPanelProps["onRemove"];
}) {
  const isMod = line.kind === "Mo";
  const selectable = selecting && !isMod;
  return (
    <div
      className={`cl ${isMod ? "mod" : ""} ${line.sent ? "sent" : "fresh"} ${line.isVoid ? "void" : ""} ${selectable ? "selectable" : ""} ${checked ? "picked" : ""}`}
      style={{ paddingLeft: 10 + line.indentLevel * 16 }}
      onClick={selectable ? () => onToggle(line.key) : undefined}
    >
      <div className="clmain">
        {selectable && <span className="clcheck">{checked ? "☑" : "☐"}</span>}
        <span className="clqty">{line.quantity > 1 ? `${line.quantity}×` : ""}</span>
        <span className="clname">{line.description}</span>
        <span className="clamt">{line.amount ? fmt(lineExtended(line)) : ""}</span>
      </div>
      {!selecting && !line.sent && !isMod && (
        <div className="clctl">
          <button onClick={() => onQty(line.key, line.quantity - 1)}>–</button>
          <span>{line.quantity}</span>
          <button onClick={() => onQty(line.key, line.quantity + 1)}>+</button>
          <button className="rm" onClick={() => onRemove(line.key)}>Remove</button>
        </div>
      )}
    </div>
  );
}

export default function CheckPanel(p: CheckPanelProps) {
  const { check, tax } = p;
  const subtotal = checkSubtotal(check);
  const total = grandTotal(subtotal, tax);
  const nUnsent = unsentLines(check).length;
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const shown = check.lines.filter((l) => !l.transferOut); // hide void-off lines
  const itemCount = shown.filter((l) => l.kind === "M").length;
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const exitSplit = () => { setSelecting(false); setSel(new Set()); };
  const doSplit = () => { if (sel.size) p.onSplit(new Set(sel)); exitSplit(); };

  return (
    <aside className="checkpanel">
      <div className="chead">
        <input className="ctable" placeholder="Table" value={check.tableName} onChange={(e) => p.onSetTable(e.target.value)} />
        <div className="cguests">
          <button onClick={() => p.onSetGuests(check.guestCount - 1)}>–</button>
          <span>{check.guestCount}g</span>
          <button onClick={() => p.onSetGuests(check.guestCount + 1)}>+</button>
        </div>
      </div>
      <div className="crc">{p.revenueCenterName}{check.checkNumber ? ` · Check ${check.checkNumber}` : ""}</div>

      <div className="clines">
        {shown.length === 0 && <div className="cempty">Tap items to start the order.</div>}
        {shown.map((l) => (
          <LineRow key={l.key} line={l} selecting={selecting} checked={sel.has(l.key)} onToggle={toggle} onQty={p.onQty} onRemove={p.onRemove} />
        ))}
      </div>

      <div className="cfoot">
        {selecting ? (
          <div className="cactions">
            <button className="cnew" onClick={exitSplit}>Cancel</button>
            <button className="csend" onClick={doSplit} disabled={p.sending || sel.size === 0}>Move {sel.size || ""} to new check</button>
          </div>
        ) : (
          <>
            <div className="csubline"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
            {tax.taxTotal > 0 && <div className="csubline"><span>Tax</span><span>{fmt(tax.taxTotal)}</span></div>}
            {tax.inclusiveTax > 0 && <div className="csubline dim"><span>incl. tax</span><span>{fmt(tax.inclusiveTax)}</span></div>}
            <div className="csub"><span>Total</span><b>{fmt(total)}</b></div>
            {p.sendError && <div className="cerr">{p.sendError}</div>}
            <div className="cactions">
              <button className="cnew" onClick={p.onNewCheck} disabled={p.sending}>New</button>
              <button className="csend" onClick={p.onSend} disabled={p.sending || nUnsent === 0}>
                {p.sending ? "Sending…" : nUnsent > 0 ? `Send ${nUnsent} to kitchen` : "Sent"}
              </button>
            </div>
            <div className="cactions">
              {itemCount > 1 && <button className="cnew wide" onClick={() => setSelecting(true)} disabled={p.sending}>Split</button>}
              <button className="cpay" onClick={p.onPay} disabled={p.sending || check.lines.length === 0}>Pay</button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
