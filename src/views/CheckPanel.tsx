/*
 * Check panel — the running order the server is building, beside the menu grid.
 * Renders the check's line items (modifiers indented under their parent), a
 * table/guest header, a running subtotal/tax/total, Send, Pay, and a Split mode
 * (select item lines → move them to a new check). Presentation only; all
 * mutation goes through useCheck / the Menu orchestration.
 */

import { useState } from "react";
import { checkSubtotal, highestGuestNumber, lineExtended, refIsShown, sortLinesByGuest, unsentLines, type Check, type CheckLine } from "@/model/check";
import { grandTotal, type TaxResult } from "@/model/tax";

const fmt = (n: number): string => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const firstName = (s: string): string => (s || "").trim().split(/\s+/)[0] || "";
function timeLabel(d: Date): string {
  let h = d.getHours(); const m = d.getMinutes(); const ap = h < 12 ? "a" : "p";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}

export interface CheckPanelProps {
  check: Check;
  tax: TaxResult;
  revenueCenterName: string;
  orderName?: string;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onSetTable: (name: string) => void;
  onSetGuests: (n: number) => void;
  onSend: () => void;
  onPay: () => void;
  onSplit: (keys: Set<string>) => void;
  onVoid: (keys: Set<string>) => void;
  onNewCheck: () => void;
  editing?: boolean;                       // Edit mode driven by the top strip
  onEditingChange?: (v: boolean) => void;
  selectedKeys?: Set<string>;              // selection owned by Menu (shared with the Edit grid)
  onToggleLine?: (key: string) => void;
  sortByGuest?: boolean;                   // Sort Guest — display order by guest number
  tableNumber?: string;                    // table's display number (from the DiningTable def), not Check_Name
  currentGuest?: number;                   // selected guest (0-based; -1 = "T" whole table)
  onSelectGuest?: (g: number) => void;     // pick the guest new items land on
  onAddGuest?: () => void;                 // "+" — add a guest and select it
  guestLocked?: boolean;                   // a modifier flow is open: the seat cannot change mid-flow
  sending?: boolean;
  sendError?: string;
}

function LineRow({ line, selecting, checked, showGuest, onToggle, onQty, onRemove }: {
  line: CheckLine; selecting: boolean; checked: boolean; showGuest: boolean; onToggle: (k: string) => void;
  onQty: CheckPanelProps["onQty"]; onRemove: CheckPanelProps["onRemove"];
}) {
  if (line.kind === "R") {
    // A shown reference line — a plain note on the check (no qty/price/controls).
    return (
      <div className="cl ref" style={{ paddingLeft: 10 + line.indentLevel * 16 }}>
        <div className="clmain"><span className="clnote">{line.reference}</span></div>
      </div>
    );
  }
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
        {showGuest && line.kind === "M" && (
          <span className="clguest">{line.appliedToGuests === "0" ? "T" : `G${line.guestNumber ?? 1}`}</span>
        )}
        <span className="clqty">{line.quantity > 1 ? `${line.quantity}×` : ""}</span>
        <span className="clname">{line.description}{line.held && <span className="clheld">HELD</span>}</span>
        <span className="clamt">{line.amount ? fmt(lineExtended(line)) : ""}</span>
      </div>
      {!selecting && !line.sent && line.kind === "M" && (
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
  const selecting = p.editing ?? false;                    // Edit mode is controlled by the top strip
  const sel = p.selectedKeys ?? new Set<string>();          // selection is owned by Menu (shared with the Edit grid)

  // Hide void-off/reversal lines and machine-only reference lines (only shown
  // Type="R" notes render — refIsShown mirrors the iPad display filter).
  const shown = check.lines.filter((l) =>
    !l.transferOut && !l.isSplit && !(l.isVoid && l.amount < 0) && !(l.kind === "R" && !refIsShown(l)));
  const itemCount = shown.filter((l) => l.kind === "M").length;
  // Sort Guest: order item families (item + its modifiers) by guest number.
  const display = p.sortByGuest ? sortLinesByGuest(shown) : shown;

  // The guest selector bar (avatars · + · T), per the iPad -setGuestButtons.
  const nGuests = highestGuestNumber(check);
  const cur = p.currentGuest ?? 0;

  // The order's start time — captured when the panel first mounts for this check.
  const [opened] = useState(() => timeLabel(new Date()));
  // A table check labels by its table number (from the def); otherwise by the
  // check's own name (Check_Name), falling back to the server's name.
  const orderLabel = (check.diningTableId
    ? `Table ${p.tableNumber ?? ""}`.trim()
    : check.tableName || firstName(p.orderName ?? "") || "Order").toUpperCase();
  const party = `${orderLabel} · Party of ${check.guestCount}`;

  return (
    <aside className="checkpanel">
      <div className="chead">
        <div className="chl">
          <div className="cparty">{party}</div>
          <div className="ctime">{opened}</div>
        </div>
        <div className="chr">
          <div className="ccheckno">{check.checkNumber ? `Check ${check.checkNumber}` : "New check"}<i className={`cdot ${nUnsent > 0 ? "live" : ""}`} /></div>
          <div className="ctotal">{fmt(total)}</div>
          {itemCount > 0 && (
            <div className="cbreak">
              Subtotal {fmt(subtotal)} · Tax {fmt(tax.taxTotal)}
              {tax.groups.some((g) => g.isExempt) && <span className="cexempt"> · Exempt: {tax.groups.filter((g) => g.isExempt).map((g) => g.name).join(", ")}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="csub2">
        <input className="ctable" placeholder="Table / name" value={check.tableName} onChange={(e) => p.onSetTable(e.target.value)} />
        <div className="cguests">
          <button onClick={() => p.onSetGuests(check.guestCount - 1)}>–</button>
          <span>{check.guestCount}g</span>
          <button onClick={() => p.onSetGuests(check.guestCount + 1)}>+</button>
        </div>
      </div>

      <div className="clines">
        {shown.length === 0 ? (
          <div className="cempty">
            <div className="cemptybig">Ready when you are.</div>
            <div className="cemptyrule" />
            <div className="cemptysub">Pick a category to start</div>
          </div>
        ) : display.map((l) => (
          <LineRow key={l.key} line={l} selecting={selecting} checked={sel.has(l.key)} showGuest={nGuests > 1} onToggle={p.onToggleLine ?? (() => {})} onQty={p.onQty} onRemove={p.onRemove} />
        ))}
      </div>

      {!selecting && p.onSelectGuest && (
        <div className="cguestbar" role="tablist" aria-label="Guest">
          {Array.from({ length: nGuests }, (_, i) => (
            <button key={i} className={`gbtn ${cur === i ? "on" : ""}`} disabled={p.guestLocked} onClick={() => p.onSelectGuest!(i)}>{i + 1}</button>
          ))}
          <button className="gbtn add" aria-label="Add guest" disabled={p.guestLocked} onClick={() => p.onAddGuest?.()}>+</button>
          <button className={`gbtn tbtn ${cur === -1 ? "on" : ""}`} aria-label="Whole table" disabled={p.guestLocked} onClick={() => p.onSelectGuest!(-1)}>T</button>
        </div>
      )}

      <div className="cfoot">
        {p.sendError && <div className="cerr">{p.sendError}</div>}
        {selecting ? (
          <div className="cactions">
            <span className="cselcount">{sel.size} selected</span>
            <button className="csend" onClick={() => p.onEditingChange?.(false)}>Done</button>
          </div>
        ) : (
          <div className="cactions">
            <button className="cnew" onClick={p.onNewCheck} disabled={p.sending}>New</button>
            {itemCount >= 1 && <button className="cnew wide" onClick={() => p.onEditingChange?.(true)} disabled={p.sending}>Edit check</button>}
          </div>
        )}
      </div>
    </aside>
  );
}
