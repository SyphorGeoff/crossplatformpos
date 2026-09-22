/*
 * Split Check — one drag-and-drop screen for Split Guest and Transfer Item.
 * Presentation follows Paul's Split Check v1/v1.1 (AireusSplitCheckViewController:
 * original check locked on the left, new/existing check columns on the right,
 * guest-colored cards, guest filter chips, Auto Split by Guest, Move Guest,
 * + Add Check, rename, undo, live running totals, Apply). The engine is ours and
 * iOS-faithful: this screen only builds a plan; Menu.applySplit runs it through
 * model/check.ts moveLines (Transfered_Out void-offs + chksplit/lixfer records).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Check, CheckLine } from "@/model/check";
import type { OpenCheck } from "@/protocol/tables";
import type { DiningRoom, DiningTable } from "@/model/catalog";

export type SplitKind = "chksplit" | "lixfer";      // Split Guest · Transfer Item

export interface SplitTarget { kind: "new" | "existing"; name: string; dest?: Check; keys: Set<string>; tableId?: string | null; }
export interface SplitPlan { targets: SplitTarget[]; }

interface Column { id: string; kind: "new" | "existing"; name: string; dest?: Check; occ?: OpenCheck; tableId?: string | null; } // tableId: undefined = same as source · null = tab · id = table
type Assign = Map<string, string>;   // parent line key → column id ("" = original)

const fmt = (n: number) => `$${n.toFixed(2)}`;
// Paul's 6-color guest palette (blue/terracotta/emerald/copper/violet/amber); whole-table = gold.
const GUEST_COLORS = ["#3F6AA8", "#9B5E3B", "#2F7D5B", "#B87333", "#6E5AA6", "#C58F1B"];
export const guestColor = (l: CheckLine): string =>
  l.appliedToGuests === "0" || !l.guestNumber ? "#C08A5E" : GUEST_COLORS[(l.guestNumber - 1) % GUEST_COLORS.length];
const guestTag = (l: CheckLine): string => (l.appliedToGuests === "0" || !l.guestNumber ? "T" : `G${l.guestNumber}`);

/** Item families (a parent + its modifiers) that can move — live menu items only. */
function families(check: Check): { parent: CheckLine; lines: CheckLine[] }[] {
  const out: { parent: CheckLine; lines: CheckLine[] }[] = [];
  const byKey = new Map<string, { parent: CheckLine; lines: CheckLine[] }>();
  for (const l of check.lines) {
    if (l.isVoid || l.transferOut) continue;
    if (l.kind === "M") { const f = { parent: l, lines: [l] }; out.push(f); byKey.set(l.key, f); }
    else if (l.kind === "Mo" && l.parentKey && byKey.has(l.parentKey)) byKey.get(l.parentKey)!.lines.push(l);
  }
  return out;
}

export default function SplitCheck(p: {
  check: Check; kind: SplitKind; isTable: boolean; where: string;   // "Table 13" / "Tab Smith" / ""
  preselect?: Set<string>;
  totalFor: (lines: CheckLine[]) => number;                          // grand total incl. tax
  openChecks: OpenCheck[];
  tables: DiningTable[]; rooms: DiningRoom[]; occupancy: Map<string, OpenCheck>;   // Transfer To Table picker
  loadExisting: (occ: OpenCheck) => Promise<Check | null>;           // lock + read; null when unavailable
  onCancel: () => void;
  onApply: (plan: SplitPlan) => void;
  busy?: boolean; error?: string;
}) {
  const fams = useMemo(() => families(p.check), [p.check]);
  const guests = useMemo(() => [...new Set(fams.map((f) => guestTag(f.parent)))].sort(), [fams]);

  const [cols, setCols] = useState<Column[]>([{ id: "n1", kind: "new", name: "" }, { id: "n2", kind: "new", name: "" }]);
  const [assign, setAssign] = useState<Assign>(new Map());
  const [selected, setSelected] = useState<Set<string>>(() => new Set(p.preselect ?? []));
  const [filter, setFilter] = useState<string>("");                   // "" = All, else a guest tag
  const [history, setHistory] = useState<{ cols: Column[]; assign: Assign }[]>([]);
  const [pickExisting, setPickExisting] = useState(false);
  const [pickTarget, setPickTarget] = useState<string | null>(null);   // column id choosing its Tab / Table destination
  const [hover, setHover] = useState<string | null>(null);            // drop-target column id ("" = original)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const colRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ keys: string[]; label: string; startX: number; startY: number; moving: boolean } | null>(null);

  const pushHistory = () => setHistory((h) => [...h.slice(-9), { cols, assign }]);
  const undo = () => {
    const last = history[history.length - 1]; if (!last) return;
    setHistory((h) => h.slice(0, -1)); setCols(last.cols); setAssign(last.assign);
  };

  const moveKeys = (keys: Iterable<string>, colId: string) => {
    const ks = [...keys]; if (!ks.length) return;
    pushHistory();
    setAssign((a) => { const n = new Map(a); for (const k of ks) { if (colId) n.set(k, colId); else n.delete(k); } return n; });
    setSelected(new Set());
  };

  const famsIn = (colId: string) => fams.filter((f) => (assign.get(f.parent.key) ?? "") === colId);
  const linesIn = (colId: string) => famsIn(colId).flatMap((f) => f.lines);
  const colTotal = (c: Column | null) => {
    const moved = linesIn(c?.id ?? "");
    const base = c?.dest ? p.totalFor(c.dest.lines.filter((l) => !l.isVoid && !l.transferOut)) : 0;
    return base + p.totalFor(moved);
  };
  const colLabel = (c: Column, i: number) => c.name || (c.kind === "existing" ? `Check ${c.dest?.checkNumber ?? ""}` : `New check ${i + 1}`);

  // ---- bulk actions (Paul #6/#7) ----
  const addColumn = (): string => { const id = `n${Date.now()}`; pushHistory(); setCols((cs) => [...cs, { id, kind: "new", name: "" }]); return id; };
  const moveGuestToNew = (tag: string) => {
    const keys = fams.filter((f) => guestTag(f.parent) === tag && (assign.get(f.parent.key) ?? "") === "").map((f) => f.parent.key);
    if (!keys.length) return;
    const empty = cols.find((c) => c.kind === "new" && famsIn(c.id).length === 0);
    const id = empty ? empty.id : `n${Date.now()}`;
    pushHistory();
    if (!empty) setCols((cs) => [...cs, { id, kind: "new", name: "" }]);
    setAssign((a) => { const n = new Map(a); for (const k of keys) n.set(k, id); return n; });
  };
  const autoSplit = () => {
    // one new check per guest tag, in guest order; existing empties are reused first
    const byGuest = new Map<string, string[]>();
    for (const f of fams) if ((assign.get(f.parent.key) ?? "") === "") byGuest.set(guestTag(f.parent), [...(byGuest.get(guestTag(f.parent)) ?? []), f.parent.key]);
    if (byGuest.size < 2) return;
    pushHistory();
    const next = [...cols]; const n = new Map(assign);
    const empties = next.filter((c) => c.kind === "new" && famsIn(c.id).length === 0);
    let i = 0;
    for (const [tag, keys] of [...byGuest.entries()].sort()) {
      let id = empties[i]?.id;
      if (!id) { id = `n${Date.now()}_${i}`; next.push({ id, kind: "new", name: "" }); }
      i++;
      for (const k of keys) n.set(k, id);
      void tag;
    }
    setCols(next); setAssign(n);
  };
  const rename = (c: Column) => {
    const v = window.prompt(c.kind === "existing" ? "Column label:" : p.isTable ? "Label this check (on-screen only — the table has the number):" : "Name this tab (Check_Name):", c.name);
    if (v === null) return;
    setCols((cs) => cs.map((x) => (x.id === c.id ? { ...x, name: v.trim() } : x)));
  };
  const addExisting = async (occ: OpenCheck, replaceColId?: string) => {
    setPickExisting(false); setPickTarget(null); setLoading(true);
    const dest = await p.loadExisting(occ);
    setLoading(false);
    if (!dest) return;
    pushHistory();
    const col: Column = { id: `e${occ.checkNo}`, kind: "existing", name: "", dest, occ };
    if (replaceColId) {
      // the chosen table already has an open check → that check is the destination (didSelectTableCheck)
      setCols((cs) => cs.map((c) => (c.id === replaceColId ? col : c)));
      setAssign((a) => { const n = new Map(a); for (const [k, v] of n) if (v === replaceColId) n.set(k, col.id); return n; });
    } else setCols((cs) => [...cs, col]);
  };
  const setColTable = (colId: string, tableId: string | null | undefined) => {
    setPickTarget(null);
    setCols((cs) => cs.map((c) => (c.id === colId ? { ...c, tableId } : c)));
  };
  const targetLabel = (c: Column) =>
    c.tableId === undefined ? (p.isTable ? "Same table" : "Same tab")
      : c.tableId === null ? "New tab"
      : `Table ${p.tables.find((t) => t.id === c.tableId)?.name ?? c.tableId}`;

  // ---- pointer drag (lift / hover / settle) with tap-to-select fallback ----
  const columnAt = (x: number, y: number): string | null => {
    for (const [id, el] of colRefs.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  };
  const onCardDown = (e: React.PointerEvent, f: { parent: CheckLine }) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const keys = selected.has(f.parent.key) ? [...selected] : [f.parent.key];
    drag.current = { keys, label: keys.length > 1 ? `${keys.length} items` : f.parent.description, startX: e.clientX, startY: e.clientY, moving: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCardMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (!d.moving && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return;
    d.moving = true;
    setGhost({ x: e.clientX, y: e.clientY, label: d.label });
    setHover(columnAt(e.clientX, e.clientY));
  };
  const onCardUp = (e: React.PointerEvent, f: { parent: CheckLine }) => {
    const d = drag.current; drag.current = null; setGhost(null); setHover(null);
    if (!d) return;
    if (!d.moving) { // tap → toggle selection
      setSelected((s) => { const n = new Set(s); if (n.has(f.parent.key)) n.delete(f.parent.key); else n.add(f.parent.key); return n; });
      return;
    }
    const target = columnAt(e.clientX, e.clientY);
    if (target !== null && target !== (assign.get(f.parent.key) ?? "")) moveKeys(d.keys, target);
  };
  useEffect(() => { const up = () => { drag.current = null; setGhost(null); setHover(null); }; window.addEventListener("pointercancel", up); return () => window.removeEventListener("pointercancel", up); }, []);

  const pendingCount = [...assign.values()].length;
  const canApply = pendingCount > 0 && !p.busy && !loading;
  const cancel = () => {
    if (pendingCount > 0 && !window.confirm("Cancel split? Nothing has been posted yet — your moves will be discarded.")) return;
    p.onCancel();
  };
  const apply = () => {
    const targets: SplitTarget[] = cols
      .map((c) => ({ kind: c.kind, name: c.name, dest: c.dest, tableId: c.tableId, keys: new Set(famsIn(c.id).map((f) => f.parent.key)) }))
      .filter((t) => t.keys.size > 0);
    p.onApply({ targets });
  };

  const title = p.kind === "chksplit" ? "Split Check" : "Transfer Items";
  const origVisible = famsIn("").filter((f) => !filter || guestTag(f.parent) === filter);
  const origTotal = colTotal(null);

  const Card = ({ f, colId }: { f: { parent: CheckLine; lines: CheckLine[] }; colId: string }) => (
    <div
      className={`spcard ${selected.has(f.parent.key) ? "sel" : ""}`}
      style={{ borderLeftColor: guestColor(f.parent), background: `${guestColor(f.parent)}1A` }}
      onPointerDown={(e) => onCardDown(e, f)} onPointerMove={onCardMove} onPointerUp={(e) => onCardUp(e, f)}
    >
      <span className="spdots">⋮⋮</span>
      <div className="spbody">
        <div className="spname">{f.parent.quantity > 1 ? `${f.parent.quantity}× ` : ""}{f.parent.description}</div>
        {f.lines.length > 1 && <div className="spmods">{f.lines.slice(1).map((m) => m.description).join(" · ")}</div>}
      </div>
      <span className="spguest" style={{ color: guestColor(f.parent), borderColor: guestColor(f.parent) }}>{guestTag(f.parent)}</span>
      <span className="spamt">{fmt(p.totalFor(f.lines))}</span>
      {colId !== "" && <button className="spback" title="Move back to original" onClick={() => moveKeys([f.parent.key], "")}>↩</button>}
    </div>
  );

  return (
    <div className="splitck">
      <div className="sphead">
        <div>
          <div className="spkicker">{p.kind === "chksplit" ? "ORDER · SPLIT" : "ORDER · TRANSFER"}</div>
          <h1>{title}</h1>
          <div className="spmeta">Check {p.check.checkNumber ?? "—"}{p.where ? ` · ${p.where}` : ""} · drag items to a check, or tap to select and use “Move here”</div>
        </div>
        <div className="sptabs">
          <button className="sppill add" onClick={() => addColumn()}>+ Add Check</button>
          {p.kind === "lixfer" && <button className="sppill" onClick={() => setPickExisting(true)} disabled={loading}>{loading ? "Loading…" : "Existing check…"}</button>}
        </div>
      </div>

      <div className="spcols">
        {/* Original — locked source */}
        <div ref={(el) => { if (el) colRefs.current.set("", el); }} className={`spcol orig ${hover === "" ? "drop" : ""}`}>
          <div className="spcolhead">
            <span className="sppos">ORIGINAL</span>
            <span className="splock">🔒 LOCKED</span>
          </div>
          <div className="spcolname">Check {p.check.checkNumber ?? "—"}</div>
          {guests.length > 1 && (
            <div className="spchips">
              <button className={`spchip ${!filter ? "on" : ""}`} onClick={() => setFilter("")}>All</button>
              {guests.map((g) => <button key={g} className={`spchip ${filter === g ? "on" : ""}`} onClick={() => setFilter(g)}>{g}</button>)}
            </div>
          )}
          <div className="spcards">
            {origVisible.length === 0 && <div className="sphint">{famsIn("").length === 0 ? "Everything has moved" : "No items for this guest"}</div>}
            {origVisible.map((f) => <Card key={f.parent.key} f={f} colId="" />)}
          </div>
          <div className="spfoot">
            {filter && <button className="sppill ghost" onClick={() => moveGuestToNew(filter)}>Move {filter} to New Check</button>}
            {selected.size > 0 && [...selected].some((k) => (assign.get(k) ?? "") !== "") && <button className="sppill ghost" onClick={() => moveKeys(selected, "")}>Move here ({selected.size})</button>}
            <div className="sptotal"><span>TOTAL</span><b>{fmt(origTotal)}</b></div>
          </div>
        </div>

        {cols.map((c, i) => {
          const inCol = famsIn(c.id);
          return (
            <div key={c.id} ref={(el) => { if (el) colRefs.current.set(c.id, el); else colRefs.current.delete(c.id); }} className={`spcol ${hover === c.id ? "drop" : ""}`}>
              <div className="spcolhead">
                <span className="sppos">{c.kind === "existing" ? "EXISTING" : `${i + 1} OF ${cols.length}`}</span>
                {c.kind === "existing" && c.dest?.checkNumber && <span className="spno">#{c.dest.checkNumber}</span>}
              </div>
              <button className="spcolname edit" onClick={() => rename(c)} title="Rename">{colLabel(c, i)} <i>✎</i></button>
              {c.kind === "new" && p.kind === "lixfer" && (
                <button className="sppill ghost sptarget" onClick={() => setPickTarget(c.id)} title="Transfer To Tab / Transfer To Table">→ {targetLabel(c)} ▾</button>
              )}
              <div className="spcards">
                {inCol.length === 0 && (
                  <div className="sphint drop"><span className="sparrow">↓</span>Drag items here</div>
                )}
                {c.dest && inCol.length > 0 && <div className="spexisting">{c.dest.lines.filter((l) => l.kind === "M" && !l.isVoid && !l.transferOut).length} item(s) already on this check</div>}
                {inCol.map((f) => <Card key={f.parent.key} f={f} colId={c.id} />)}
              </div>
              <div className="spfoot">
                {selected.size > 0 && <button className="sppill ghost" onClick={() => moveKeys(selected, c.id)}>Move here ({selected.size})</button>}
                <div className="sptotal"><span>TOTAL</span><b>{fmt(colTotal(c))}</b></div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="spbar">
        <button className="mfbtn ghost" onClick={cancel} disabled={p.busy}>Cancel</button>
        <button className="mfbtn ghost" onClick={autoSplit} disabled={p.busy || guests.length < 2}>Auto Split by Guest</button>
        {history.length > 0 && <button className="mfbtn ghost" onClick={undo} disabled={p.busy}>↺ Undo ({history.length})</button>}
        <span className="spinfo">
          {p.error ? <span className="cerr">{p.error}</span>
            : pendingCount === 0 ? "Tap + Add Check to start a new check, then drag items across."
            : `${pendingCount} item(s) pending. They move on Apply — the kitchen isn't re-notified for already-sent items.`}
        </span>
        <button className="mfbtn go" onClick={apply} disabled={!canApply}>{p.busy ? "Applying…" : p.kind === "chksplit" ? "Apply Split" : "Transfer"}</button>
      </div>

      {ghost && <div className="spghost" style={{ left: ghost.x, top: ghost.y }}>{ghost.label}</div>}

      {pickTarget && (
        <div className="backdrop" onClick={() => setPickTarget(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Transfer Items</div>
            <div className="authsub">Where should this new check live?</div>
            <div className="mgrlist">
              <button className="mgrrow" onClick={() => setColTable(pickTarget, undefined)}>{p.isTable ? "Same table as the source" : "Same tab as the source"}</button>
              <button className="mgrrow" onClick={() => setColTable(pickTarget, null)}>Transfer To Tab<span>new counter tab</span></button>
              {p.rooms.map((r) => (
                <div key={r.id} className="sproom">
                  <div className="sproomname">{r.name}</div>
                  <div className="sptables">
                    {p.tables.filter((t) => t.roomId === r.id).map((t) => {
                      const occ = p.occupancy.get(t.id);
                      return (
                        <button key={t.id} className={`sptable ${occ ? "occ" : ""}`}
                          title={occ ? `Open check ${occ.checkNo} — items join it` : `New check on table ${t.name}`}
                          onClick={() => (occ ? void addExisting(occ, pickTarget) : setColTable(pickTarget, t.id))}>
                          {t.name}{occ && <small>#{occ.checkNo}</small>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <button className="mfbtn ghost" onClick={() => setPickTarget(null)}>Cancel</button>
          </div>
        </div>
      )}

      {pickExisting && (
        <div className="backdrop" onClick={() => setPickExisting(false)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Transfer to an open check</div>
            <div className="mgrlist">
              {p.openChecks.filter((o) => o.checkNo !== p.check.checkNumber && !cols.some((c) => c.occ?.checkNo === o.checkNo)).map((o) => (
                <button key={o.checkNo} className="mgrrow" onClick={() => void addExisting(o)}>Check {o.checkNo}<span>{o.tableId ? "table" : "tab"}</span></button>
              ))}
              {p.openChecks.length === 0 && <div className="hint">No other open checks.</div>}
            </div>
            <button className="mfbtn ghost" onClick={() => setPickExisting(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
