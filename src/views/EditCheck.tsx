/*
 * Edit Check — the check-editing function grid (Paul's counter layout). Shown on
 * the right in place of the menu when Edit is active; the check panel (left)
 * keeps its line checkboxes so the selection-based functions (Void Selected,
 * Split Item, Change Price, …) act on the picked lines. Functions map to the
 * ground-truth iOS edit set; those not built yet render disabled.
 */

const fmt = (n: number): string => `$${n.toFixed(2)}`;

export interface EditCheckActions {
  discount?: () => void;
  voidSelected?: () => void;
  selectAll?: () => void;
  unselectAll?: () => void;
  splitItem?: () => void;
  transferCheck?: () => void;
  mergeCheck?: () => void;      // this check INTO another open check (Geoff 2026-10-16: its own tile)
  searchMenu?: () => void;
  changeRc?: () => void;
  // — not yet built (render disabled until wired to the iOS behavior) —
  nameTab?: () => void;
  transferItem?: () => void;
  reorder?: () => void;
  holdUnhold?: () => void;
  splitGuest?: () => void;
  serviceCharge?: () => void;
  textCheck?: () => void;
  removeAllTax?: () => void;
  removeTax?: () => void;
  guestCount?: () => void;
  changePrice?: () => void;
  reprintLast?: () => void;
  sortGuest?: () => void;
  changeGuest?: () => void;
  refire?: () => void;
  changeCourse?: () => void;   // course chooser for the selected lines (CouringViewController)
}

export interface EditCheckProps {
  checkNo: string;
  kindLabel: string;   // "Tab" or "Table 12"
  guests: number;
  subtotal: number;
  selCount: number;
  actions: EditCheckActions;
}

function Fn({ glyph, label, sub, onClick }: { glyph: string; label: string; sub?: string; onClick?: () => void }) {
  return (
    <button className="ecfn" onClick={onClick} disabled={!onClick} title={onClick ? label : `${label} — coming soon`}>
      <span className="ecglyph">{glyph}</span>
      <span className="ecfnlabel">{label}</span>
      {sub && <span className="ecfnsub">{sub}</span>}
    </button>
  );
}

export default function EditCheck(p: EditCheckProps) {
  const a = p.actions;
  const n = p.selCount ? ` (${p.selCount})` : "";
  return (
    <div className="editcheck">
      <div className="echead">
        <div className="eckicker">ORDER · EDIT</div>
        <h1>Edit Check</h1>
        <div className="ecmeta">Check {p.checkNo} · {p.kindLabel} · {p.guests} guest{p.guests === 1 ? "" : "s"}<br /><span>{fmt(p.subtotal)} subtotal</span></div>
      </div>

      <div className="echero">
        <button className="echerocard" onClick={a.discount} disabled={!a.discount}>
          <span className="ecglyph">%</span>
          <div><div className="ecfnlabel">Discount</div><div className="ecfnsub">% off · $ off · Comp</div></div>
        </button>
        <button className="echerocard" onClick={a.voidSelected} disabled={!a.voidSelected || p.selCount === 0}>
          <span className="ecglyph">⊗</span>
          <div><div className="ecfnlabel">Void Selected{n}</div><div className="ecfnsub">Deletes every selected item</div></div>
        </button>
        <button className="echerocard" onClick={a.selectAll} disabled={!a.selectAll}>
          <span className="ecglyph">☑</span>
          <div><div className="ecfnlabel">Select All</div><div className="ecfnsub">Mark every line</div></div>
        </button>
      </div>

      <div className="ecgrid">
        <Fn glyph="✎" label="Name Tab" onClick={a.nameTab} />
        <Fn glyph="↪" label="Transfer Check" onClick={a.transferCheck} />
        <Fn glyph="⧉" label="Merge Checks" onClick={a.mergeCheck} />
        <Fn glyph="↗" label="Transfer Item" onClick={a.transferItem} />
        <Fn glyph="☐" label="Unselect All" onClick={a.unselectAll} />
        <Fn glyph="⋔" label={`Split Item${n}`} onClick={a.splitItem} />

        <Fn glyph="↻" label="Re-order" onClick={a.reorder} />
        <Fn glyph="‖" label="Hold / Unhold" onClick={a.holdUnhold} />
        <Fn glyph="⧉" label="Split Guest" onClick={a.splitGuest} />
        <Fn glyph="⊕" label="Service Charge" onClick={a.serviceCharge} />
        <Fn glyph="⌕" label="Search Menu" onClick={a.searchMenu} />

        <Fn glyph="✉" label="Text Check" onClick={a.textCheck} />
        <Fn glyph="⊘" label="Remove All Tax" onClick={a.removeAllTax} />
        <Fn glyph="⊘" label="Remove Tax" onClick={a.removeTax} />
        <Fn glyph="#" label="Guest Count" onClick={a.guestCount} />

        <Fn glyph="$" label="Change Price" onClick={a.changePrice} />
        <Fn glyph="⇄" label="Change Revenue Centre" onClick={a.changeRc} />
        <Fn glyph="⎙" label="Reprint Last Check" onClick={a.reprintLast} />
        <Fn glyph="⇅" label="Sort Guest" onClick={a.sortGuest} />
        <Fn glyph="◐" label={`Change Guest${n}`} onClick={a.changeGuest} />
        <Fn glyph="🔥" label={`Refire${n}`} onClick={a.refire} />
        <Fn glyph="≡" label={`Change Course${n}`} onClick={a.changeCourse} />
      </div>
    </div>
  );
}
