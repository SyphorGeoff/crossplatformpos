/*
 * Clock-in gate — after PIN login, before ordering (the iOS LoginConfirm flow):
 *   1. "Welcome / {name}" confirm (Cancel returns to the keypad)
 *   2. pick a job → clock in (Time_Card)  [a clock-in chit prints unless the
 *      job suppresses it — handled by the caller]
 *   3. if the job is NOT Skip_Table, pick the default dining room
 * Ordering opens only once the shift is committed — no check without a clock-in.
 */

import { useState } from "react";
import type { CurrentEmployee } from "@/state/useEmployee";
import type { DiningRoom, Job } from "@/model/catalog";

export interface ShiftCommit { jobId: string; jobName: string; sequence: string; defaultRoomId: string; }

export default function ClockInGate({ employee, jobs, rooms, onClockIn, onCommit, onCancel }: {
  employee: CurrentEmployee;
  jobs: Job[];
  rooms: DiningRoom[];
  onClockIn: (job: Job) => Promise<{ ok: boolean; sequence: string; message: string }>;
  onCommit: (c: ShiftCommit) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"confirm" | "job" | "room">("confirm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shift, setShift] = useState<{ job: Job; sequence: string } | null>(null);

  const pickJob = async (job: Job) => {
    setBusy(true); setError("");
    const r = await onClockIn(job);
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    if (job.skipTable || rooms.length === 0) {
      onCommit({ jobId: job.id, jobName: job.name, sequence: r.sequence, defaultRoomId: "" });
    } else {
      setShift({ job, sequence: r.sequence }); setPhase("room");
    }
  };
  const pickRoom = (roomId: string) => {
    if (!shift) return;
    onCommit({ jobId: shift.job.id, jobName: shift.job.name, sequence: shift.sequence, defaultRoomId: roomId });
  };

  return (
    <div className="login">
      <div className="cinbox">
        {phase === "confirm" && (
          <>
            <div className="cinname">{employee.name}</div>
            <div className="cinactions">
              <button className="cinbtn" onClick={onCancel}>Cancel</button>
              <button className="cinbtn ok" onClick={() => setPhase("job")}>OK</button>
            </div>
            <div className="cinwelcome">Welcome</div>
          </>
        )}

        {phase === "job" && (
          <>
            <div className="cinname sm">{employee.name}</div>
            <div className="cinprompt">Clock in to start your shift</div>
            {error && <div className="loginerr">{error}</div>}
            <div className="cinlist">
              {jobs.map((j) => (
                <button key={j.id} className="cinrow" disabled={busy} onClick={() => void pickJob(j)}>
                  {j.name}<span>${j.regularRate.toFixed(2)}/hr</span>
                </button>
              ))}
              {jobs.length === 0 && (
                <button className="cinrow" disabled={busy} onClick={() => void pickJob({ id: "", name: "", regularRate: 0, skipTable: true } as Job)}>Clock in</button>
              )}
            </div>
            <button className="cinback" disabled={busy} onClick={() => { setError(""); setPhase("confirm"); }}>Back</button>
          </>
        )}

        {phase === "room" && (
          <>
            <div className="cinname sm">{employee.name}</div>
            <div className="cinprompt">Choose your default dining room</div>
            <div className="cinlist">
              {[...rooms].sort((a, b) => a.sort - b.sort).map((r) => (
                <button key={r.id} className="cinrow" onClick={() => pickRoom(r.id)}>{r.name}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
