/*
 * Small manager pickers shared by the Manager's Menu actions (iOS: EmployToTranferFrom,
 * ToEmployeeViewController, EmployeeListViewController type Empty_Check,
 * ClockInEmployeesViewController). Each is a backdrop sheet with a list; the parent does
 * the work. Presentation only.
 */

import type { ClockedInEmp } from "@/protocol/timeclock";

export interface PickEmployeeProps {
  title: string;
  sub?: string;
  rows: Array<{ id: string; name: string; note?: string }>;
  emptyText: string;
  busy?: boolean;
  onPick: (id: string) => void;
  onCancel: () => void;
}

/** Pick one employee from a list (Transfer All from / to, Open Empty Check for). */
export function PickEmployee(p: PickEmployeeProps) {
  return (
    <div className="backdrop" onClick={p.busy ? undefined : p.onCancel}>
      <div className="authbox" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">{p.title}</div>
        {p.sub && <div className="authsub">{p.sub}</div>}
        <div className="mgrlist">
          {p.rows.map((r) => (
            <button key={r.id} className="mgrrow" disabled={p.busy} onClick={() => p.onPick(r.id)}>{r.name}{r.note ? <span>{r.note}</span> : null}</button>
          ))}
          {p.rows.length === 0 && <div className="hint">{p.emptyText}</div>}
        </div>
        <button className="mfbtn ghost" disabled={p.busy} onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export interface ClockedInListProps {
  rows: ClockedInEmp[] | null;                      // null = loading
  nameForEmp: (id: string) => string;
  nameForJob: (id: string) => string;
  openChecksOf: (id: string) => number;             // how many open checks the employee owns (blocks a plain clock-out)
  status?: string;
  busy?: boolean;
  onClockOut: (row: ClockedInEmp, force: boolean) => void;
  onCancel: () => void;
}

/** Clocked In Employees: who is on the clock, since when, and clock them out from here. */
export function ClockedInList(p: ClockedInListProps) {
  return (
    <div className="backdrop" onClick={p.busy ? undefined : p.onCancel}>
      <div className="authbox" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">Clocked In Employees</div>
        {p.status && <div className="authsub">{p.status}</div>}
        <div className="mgrlist">
          {p.rows == null && <div className="hint">Loading…</div>}
          {(p.rows ?? []).map((r) => {
            const open = p.openChecksOf(r.empId);
            return (
              <button key={`${r.empId}-${r.sequence}`} className="mgrrow" disabled={p.busy} onClick={() => p.onClockOut(r, open > 0)}>
                {p.nameForEmp(r.empId) || r.empId}
                <span>{p.nameForJob(r.jobId) || r.jobId}{r.clockInTime ? ` · in ${r.clockInTime.slice(11, 16)}` : ""}{open > 0 ? ` · ${open} open check${open > 1 ? "s" : ""} — clock out anyway` : " · clock out"}</span>
              </button>
            );
          })}
          {p.rows != null && p.rows.length === 0 && <div className="hint">Nobody is clocked in.</div>}
        </div>
        <button className="mfbtn ghost" disabled={p.busy} onClick={p.onCancel}>Close</button>
      </div>
    </div>
  );
}
