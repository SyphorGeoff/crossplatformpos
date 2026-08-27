/*
 * Manager / functions panel — timeclock (clock in/out with job pick), no-sale,
 * cancel check, and discounts/comps. Actions the signed-in employee's job
 * doesn't permit are gated by a manager PIN upstream (Menu). Presentation only.
 */

import { useState } from "react";
import type { CurrentEmployee } from "@/state/useEmployee";
import type { Perms } from "@/model/permissions";
import type { Adjustment, Job } from "@/model/catalog";

export interface ClockState { jobId: string; jobName: string; sequence: string; }

export interface ManagerPanelProps {
  employee: CurrentEmployee;
  perms: Perms;
  clocked: ClockState | null;
  jobs: Job[];
  adjustments: Adjustment[];
  hasCheck: boolean;
  busy: boolean;
  status?: string;
  onClockIn: (job: Job) => void;
  onClockOut: () => void;
  onNoSale: () => void;
  onCancelCheck: () => void;
  onDiscount: (a: Adjustment) => void;
  onClose: () => void;
}

export default function ManagerPanel(p: ManagerPanelProps) {
  const [view, setView] = useState<"main" | "clockin" | "discounts">("main");
  const discountable = p.adjustments.filter((a) => !a.isAutomatic);

  return (
    <div className="backdrop" onClick={p.busy ? undefined : p.onClose}>
      <div className="mgrpanel" onClick={(e) => e.stopPropagation()}>
        <div className="mgrhead">
          <div><div className="mgrtitle">Functions</div><div className="mgrsub">{p.employee.name}</div></div>
          <button className="x" onClick={p.onClose} disabled={p.busy}>✕</button>
        </div>
        {p.status && <div className="mgrstatus">{p.status}</div>}

        {view === "main" && (
          <div className="mgrgrid">
            {p.clocked
              ? <button className="mgrbtn" disabled={p.busy} onClick={p.onClockOut}>Clock out<small>{p.clocked.jobName}</small></button>
              : <button className="mgrbtn" disabled={p.busy} onClick={() => setView("clockin")}>Clock in</button>}
            <button className="mgrbtn" disabled={p.busy || !p.perms.noSale} onClick={p.onNoSale}>No sale<small>open drawer</small></button>
            <button className="mgrbtn" disabled={p.busy || !p.hasCheck} onClick={() => setView("discounts")}>Discount / comp</button>
            <button className="mgrbtn danger" disabled={p.busy || !p.hasCheck} onClick={p.onCancelCheck}>Cancel check</button>
          </div>
        )}

        {view === "clockin" && (
          <div className="mgrlist">
            <div className="mgrlabel">Clock in as…</div>
            {p.jobs.map((j) => (
              <button key={j.id} className="mgrrow" disabled={p.busy} onClick={() => p.onClockIn(j)}>
                {j.name}<span>${j.regularRate.toFixed(2)}/hr</span>
              </button>
            ))}
            {p.jobs.length === 0 && <div className="mgrsub">No jobs assigned to this employee.</div>}
            <button className="mfbtn ghost" onClick={() => setView("main")}>Back</button>
          </div>
        )}

        {view === "discounts" && (
          <div className="mgrlist">
            <div className="mgrlabel">Apply discount / comp / charge</div>
            {discountable.map((a) => (
              <button key={a.id} className="mgrrow" disabled={p.busy} onClick={() => p.onDiscount(a)}>
                {a.name}
                <span>{a.isOpen ? "open" : a.isPercentage ? `${a.amount}%` : `$${a.amount.toFixed(2)}`}{a.requiresAuth ? " · auth" : ""}</span>
              </button>
            ))}
            <button className="mfbtn ghost" onClick={() => setView("main")}>Back</button>
          </div>
        )}
      </div>
    </div>
  );
}
