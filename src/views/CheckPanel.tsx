/*
 * Check panel — the running order the server is building, beside the menu grid.
 * Renders the check's line items (modifiers indented under their parent), a
 * table/guest header, a running subtotal, and the Send-to-kitchen action.
 * Presentation only; all mutation goes through useCheck.
 */

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
  onNewCheck: () => void;
  sending?: boolean;
  sendError?: string;
}

function LineRow({ line, onQty, onRemove }: { line: CheckLine; onQty: CheckPanelProps["onQty"]; onRemove: CheckPanelProps["onRemove"] }) {
  const isMod = line.kind === "Mo";
  return (
    <div className={`cl ${isMod ? "mod" : ""} ${line.sent ? "sent" : "fresh"} ${line.isVoid ? "void" : ""}`} style={{ paddingLeft: 10 + line.indentLevel * 16 }}>
      <div className="clmain">
        <span className="clqty">{line.quantity > 1 ? `${line.quantity}×` : ""}</span>
        <span className="clname">{line.description}</span>
        <span className="clamt">{line.amount ? fmt(lineExtended(line)) : ""}</span>
      </div>
      {!line.sent && !isMod && (
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
        {check.lines.length === 0 && <div className="cempty">Tap items to start the order.</div>}
        {check.lines.map((l) => <LineRow key={l.key} line={l} onQty={p.onQty} onRemove={p.onRemove} />)}
      </div>

      <div className="cfoot">
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
        <button className="cpay" onClick={p.onPay} disabled={p.sending || check.lines.length === 0}>Pay</button>
      </div>
    </aside>
  );
}
