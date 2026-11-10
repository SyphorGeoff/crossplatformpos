/*
 * Closed Checks (Manager's Menu; iOS ClosedChecksListViewController, labelled
 * "Open Closed Checks" there). The business date's settled checks. Pick one:
 * Reopen (REOPEN_CHECK) pulls it back and re-posts it open, so it can be edited
 * — this is where a card tip gets corrected the morning after — or Reprint the
 * check. Presentation only; the parent does the work.
 */

import { useState } from "react";
import type { ClosedCheck } from "@/protocol/tables";

const fmt = (n: number) => `$${n.toFixed(2)}`;

export interface ClosedChecksViewProps {
  rows: ClosedCheck[] | null;                 // null = loading
  status?: string;
  busy: boolean;
  nameForEmp: (empPosId: string) => string;
  nameForTable: (tableId: string) => string;
  onReopen: (row: ClosedCheck) => void;
  onReprint: (row: ClosedCheck) => void;
  onRefresh: () => void;
  onBack: () => void;
}

export default function ClosedChecksView(p: ClosedChecksViewProps) {
  const [pick, setPick] = useState<ClosedCheck | null>(null);
  const label = (r: ClosedCheck) => r.tableId ? `Table ${p.nameForTable(r.tableId)}` : (r.checkName || "Tab");

  return (
    <div className="tabsview">
      <div className="tabshead">
        <h1>Closed Checks</h1>
        <div className="tabstools">
          <button className="tbbtn" onClick={p.onBack} disabled={p.busy}>‹ Manager's Menu</button>
          <button className="tbbtn" onClick={p.onRefresh} disabled={p.busy}>{p.rows == null ? "…" : "Refresh"}</button>
        </div>
      </div>

      {p.status && <div className="tabsstatus">{p.status}</div>}

      <div className="tabsgrid">
        {(p.rows ?? []).map((r) => (
          <button key={`${r.checkNo}-${r.checkKey}`} className="tabcard" disabled={p.busy} onClick={() => setPick(r)}>
            <div className="tabcardtop">
              <span className="tabcheckno">#{r.checkNo}</span>
              <span className="tabdot printed" title="Closed" />
            </div>
            <div className="tabcardlabel">{label(r)} · {fmt(r.total)}</div>
            <div className="tabcardsub">{p.nameForEmp(r.empPosId) || "—"}{r.lastModified ? ` · ${r.lastModified.slice(11, 16)}` : ""}</div>
          </button>
        ))}
        {p.rows != null && p.rows.length === 0 && <div className="empty">No closed checks today.</div>}
        {p.rows == null && <div className="empty">Loading…</div>}
      </div>

      {pick && (
        <div className="backdrop" onClick={p.busy ? undefined : () => setPick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Check #{pick.checkNo} · {label(pick)} · {fmt(pick.total)}</div>
            <div className="authsub">{p.nameForEmp(pick.empPosId) || pick.empPosId}{pick.openedOn ? ` · opened ${pick.openedOn.slice(11, 16)}` : ""}{pick.lastModified ? ` · closed ${pick.lastModified.slice(11, 16)}` : ""}</div>
            <div className="mgrlist">
              <button className="mgrrow" disabled={p.busy} onClick={() => { const r = pick; setPick(null); p.onReopen(r); }}>Reopen<span>pull the check back open to edit it or its payments</span></button>
              <button className="mgrrow" disabled={p.busy} onClick={() => { const r = pick; setPick(null); p.onReprint(r); }}>Reprint check<span>to the check printer</span></button>
            </div>
            <button className="mfbtn ghost" disabled={p.busy} onClick={() => setPick(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
