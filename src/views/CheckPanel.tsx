/*
 * Check panel — the running order the server is building, beside the menu grid.
 * Renders the check's line items (modifiers indented under their parent), a
 * table/guest header, a running subtotal/tax/total, Send, Pay, and a Split mode
 * (select item lines → move them to a new check). Presentation only; all
 * mutation goes through useCheck / the Menu orchestration.
 */

import { useEffect, useRef, useState } from "react";
import { checkSubtotal, highestGuestNumber, lineExtended, refIsShown, sortLinesByGuest, unsentLines, type Check, type CheckLine, isTimedRunning } from "@/model/check";

/** Paul's ten course hues (CheckTableViewController _courseTintForCourse), style only. */
export const COURSE_HUES = [30, 148, 198, 45, 282, 342, 210, 15, 120, 260];
export const courseHue = (n: number): number => COURSE_HUES[((Math.max(1, n) - 1) % 10)];
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
  onStopTimer?: (key: string) => void;     // timed item (sent, $0): the Stop Timer button (CheckTableCellView stopTimerButton)
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
  /* ---- coursing (RevenueCenter.showCourse / rc_backup21) ---- */
  showCourse?: boolean;                    // "C{n}" pills + course headers + chips
  courseOf?: (l: CheckLine) => number;     // effective course for a line (0 = none)
  courseLabel?: (n: number) => string;     // header text ("Course 2" unless a printer names it)
  firedCourses?: Set<number>;              // courses with a firecourse record
  onFireCourse?: (course: number) => void; // waiter fires a sent course
  onLineLongPress?: (key: string) => void; // 1-second press on a line → course chooser (iOS CheckTableCellView)
  useCourseButtons?: boolean;              // the "Adding to" course picker is shown
  addingCourse?: number;                   // 0 = Auto (item default)
  onAddingCourse?: () => void;             // open the picker
}

function LineRow({ line, selecting, checked, showGuest, onToggle, onQty, onRemove, course, onLongPress, onStopTimer }: {
  line: CheckLine; selecting: boolean; checked: boolean; showGuest: boolean; onToggle: (k: string) => void;
  onQty: CheckPanelProps["onQty"]; onRemove: CheckPanelProps["onRemove"]; onStopTimer?: CheckPanelProps["onStopTimer"];
  course?: number;                 // effective course to show as a "C{n}" pill (showCourse only)
  onLongPress?: (key: string) => void;
}) {
  // 1-second press opens the course chooser for this line (CheckTableCellView pressLong).
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = () => { if (!onLongPress) return; fired.current = false; timer.current = window.setTimeout(() => { fired.current = true; timer.current = null; onLongPress(line.key); }, 1000); };
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const press = onLongPress ? { onPointerDown: start, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear, onContextMenu: (e: React.SyntheticEvent) => e.preventDefault() } : {};
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
      onClick={selectable ? () => onToggle(line.key) : () => { if (fired.current) fired.current = false; }}
      {...press}
    >
      <div className="clmain">
        {selectable && <span className="clcheck">{checked ? "☑" : "☐"}</span>}
        {!!course && line.kind === "M" && <span className="clcourse" style={{ "--ch": courseHue(course) } as React.CSSProperties}>C{course}</span>}
        {(showGuest || line.appliedToGuests === "0") && line.kind === "M" && (
          <span className="clguest">{line.appliedToGuests === "0" ? "T" : `G${line.guestNumber ?? 1}`}</span>
        )}
        <span className="clqty">{line.quantity > 1 ? `${line.quantity}×` : ""}</span>
        <span className="clname">{line.description}{line.held && <span className="clheld">HELD</span>}{line.kind === "M" && line.reference && <span className="clitemnote">{line.reference}</span>}</span>
        <span className="clamt">{line.amount ? fmt(lineExtended(line)) : ""}</span>
      </div>
      {!selecting && isTimedRunning(line) && onStopTimer && (
        <div className="clctl">
          <button className="rm" disabled={!line.sent} title={line.sent ? "" : "Send the item to start the clock"} onClick={(e) => { e.stopPropagation(); onStopTimer(line.key); }}>Stop timer</button>
        </div>
      )}
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

const nGuestsFor = (c: Check) => highestGuestNumber(c);

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

  // ---- Coursing view (showCourse): course headers, filter chips, Ordering Mode ----
  // Sort Guest wins over course grouping (Paul's 1.0bc): flat list by guest.
  const coursing = !!p.showCourse && !p.sortByGuest && !!p.courseOf;
  const [courseFilter, setCourseFilter] = useState<number | null>(null);
  const [sentExpanded, setSentExpanded] = useState(false);
  type Family = { head: CheckLine; rest: CheckLine[]; course: number };
  const families: Family[] = [];
  const trailers: CheckLine[] = [];
  if (coursing) {
    const byKey = new Map<string, Family>();
    for (const l of shown) {
      if (l.parentKey && byKey.has(l.parentKey)) { byKey.get(l.parentKey)!.rest.push(l); continue; }
      if (l.kind === "M") { const f = { head: l, rest: [], course: p.courseOf!(l) }; families.push(f); byKey.set(l.key, f); }
      else trailers.push(l);
    }
  }
  const unsentHeads = families.filter((f) => !f.head.sent);
  const sentHeads = families.filter((f) => f.head.sent);
  const orderingMode = coursing && unsentHeads.length > 0 && !sentExpanded;
  useEffect(() => { if (unsentHeads.length === 0) setSentExpanded(false); }, [unsentHeads.length]); // Send → back to the full view
  const coursesPresent = [...new Set(families.map((f) => f.course).filter((c) => c > 0))].sort((a, b) => a - b);
  useEffect(() => { if (courseFilter !== null && !coursesPresent.includes(courseFilter)) setCourseFilter(null); }, [courseFilter, coursesPresent.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const sentTotal = sentHeads.reduce((a, f) => a + lineExtended(f.head) + f.rest.filter((r) => r.kind === "Mo").reduce((b, r) => b + lineExtended(r), 0), 0);
  const fam = (f: Family, ks: Parameters<typeof LineRow>[0] extends infer T ? Omit<T, "line"> : never) => [f.head, ...f.rest].map((l) => <LineRow key={l.key} line={l} {...ks} course={l.kind === "M" ? f.course : undefined} />);
  const rowProps = { selecting, showGuest: nGuestsFor(check) > 1, onToggle: p.onToggleLine ?? (() => {}), onQty: p.onQty, onRemove: p.onRemove, onLongPress: p.onLineLongPress, onStopTimer: p.onStopTimer };
  const courseState = (c: number): "pending" | "sent" | "fired" => {
    const heads = families.filter((f) => f.course === c);
    if (!heads.some((f) => f.head.sent)) return "pending";
    if (c === 1 || p.firedCourses?.has(c)) return "fired";
    return "sent";
  };

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

      {coursing && coursesPresent.length > 0 && !orderingMode && (
        <div className="cchips" role="tablist" aria-label="Course filter">
          <button className={`cchip ${courseFilter === null ? "on" : ""}`} onClick={() => setCourseFilter(null)}>All</button>
          {coursesPresent.map((c) => (
            <button key={c} className={`cchip ${courseFilter === c ? "on" : ""}`} style={{ "--ch": courseHue(c) } as React.CSSProperties} onClick={() => setCourseFilter(c)}>C{c}</button>
          ))}
        </div>
      )}

      <div className="clines">
        {shown.length === 0 ? (
          <div className="cempty">
            <div className="cemptybig">Ready when you are.</div>
            <div className="cemptyrule" />
            <div className="cemptysub">Pick a category to start</div>
          </div>
        ) : !coursing ? display.map((l) => (
          <LineRow key={l.key} line={l} selecting={selecting} checked={sel.has(l.key)} showGuest={nGuests > 1} onToggle={p.onToggleLine ?? (() => {})} onQty={p.onQty} onRemove={p.onRemove} onStopTimer={p.onStopTimer}
            course={p.showCourse && p.courseOf && l.kind === "M" ? p.courseOf(l) : undefined} onLongPress={p.onLineLongPress} />
        )) : orderingMode ? (
          <>
            {/* Ordering Mode (Paul 1.0bd v8/v9): unsent items on top in entry order, sent ones collapsed */}
            {unsentHeads.map((f) => fam(f, { ...rowProps, checked: sel.has(f.head.key) }))}
            {sentHeads.length > 0 && (
              <button className="csentpill" onClick={() => setSentExpanded(true)}>
                {sentHeads.length} SENT — {fmt(sentTotal)}<span>▼ TAP TO SHOW</span>
              </button>
            )}
          </>
        ) : (
          <>
            {courseFilter === null && families.filter((f) => f.course === 0).map((f) => fam(f, { ...rowProps, checked: sel.has(f.head.key) }))}
            {coursesPresent.filter((c) => courseFilter === null || c === courseFilter).map((c) => {
              const st = courseState(c);
              return (
                <div key={`c${c}`} className="ccourse-block">
                  <div className={`ccourse ${st}`} style={{ "--ch": courseHue(c) } as React.CSSProperties}>
                    <span className="cclabel">{(p.courseLabel ?? ((n: number) => `Course ${n}`))(c).toUpperCase()}</span>
                    <span className="ccstate">{st === "pending" ? "pending" : st === "fired" ? "fired" : "sent"}</span>
                    {st === "sent" && p.onFireCourse && !selecting && (
                      <button className="ccfire" onClick={() => p.onFireCourse!(c)}>▶ FIRE COURSE</button>
                    )}
                  </div>
                  {families.filter((f) => f.course === c).map((f) => fam(f, { ...rowProps, checked: sel.has(f.head.key) }))}
                </div>
              );
            })}
            {courseFilter === null && trailers.map((l) => (
              <LineRow key={l.key} line={l} selecting={selecting} checked={sel.has(l.key)} showGuest={nGuests > 1} onToggle={p.onToggleLine ?? (() => {})} onQty={p.onQty} onRemove={p.onRemove} onStopTimer={p.onStopTimer} />
            ))}
            {unsentHeads.length > 0 && <button className="csentpill collapse" onClick={() => setSentExpanded(false)}>▲ BACK TO NEW ITEMS</button>}
          </>
        )}
      </div>

      {!selecting && p.onSelectGuest && (
        <div className="cguestbar" role="tablist" aria-label="Guest">
          {Array.from({ length: nGuests }, (_, i) => (
            <button key={i} className={`gbtn ${cur === i ? "on" : ""}`} disabled={p.guestLocked} onClick={() => p.onSelectGuest!(i)}>{i + 1}</button>
          ))}
          <button className="gbtn add" aria-label="Add guest" disabled={p.guestLocked} onClick={() => p.onAddGuest?.()}>+</button>
          <button className={`gbtn tbtn ${cur === -1 ? "on" : ""}`} aria-label="Whole table" disabled={p.guestLocked} onClick={() => p.onSelectGuest!(-1)}>T</button>
          {p.useCourseButtons && p.onAddingCourse && (
            <button className={`gbtn course ${p.addingCourse ? "on" : ""}`} disabled={p.guestLocked} onClick={p.onAddingCourse}
              style={p.addingCourse ? ({ "--ch": courseHue(p.addingCourse) } as React.CSSProperties) : undefined}>
              {p.addingCourse ? `Course ${p.addingCourse} ▾` : "Course · Auto ▾"}
            </button>
          )}
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
