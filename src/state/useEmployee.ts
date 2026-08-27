/*
 * Session identity — who is signed in (Employee_POS_ID on the check) and their
 * clock-in state. The iOS flow gates ordering on clock-in: after PIN login the
 * employee confirms and clocks into a job before any check can be opened
 * (LoginConfirmViewController). We mirror that: `employee` is set at login,
 * `clock` only after a Time_Card clock-in.
 *
 * Sign-out ends the session but NOT the shift (clock stays, tied to the emp id),
 * so signing back in skips the clock-in gate — matching the iOS split between
 * sign-out and clock-out. Clock-out clears the shift.
 */

import { useCallback, useState } from "react";
import { loadJSON, remove, saveJSON } from "@/platform/storage";

export interface CurrentEmployee { id: string; name: string; }
export interface ClockState { empId: string; jobId: string; jobName: string; sequence: string; defaultRoomId: string; }

const EMP_KEY = "emp.current.v1";
const CLOCK_KEY = "emp.clock.v1";

export function useEmployee() {
  const [employee, setEmployee] = useState<CurrentEmployee | null>(() => loadJSON<CurrentEmployee | null>(EMP_KEY, null));
  const [clock, setClockState] = useState<ClockState | null>(() => loadJSON<ClockState | null>(CLOCK_KEY, null));

  const signIn = useCallback((e: CurrentEmployee) => {
    saveJSON(EMP_KEY, e); setEmployee(e);
    // Keep an existing shift only if it belongs to this employee.
    const c = loadJSON<ClockState | null>(CLOCK_KEY, null);
    if (!c || c.empId !== e.id) { remove(CLOCK_KEY); setClockState(null); }
    else setClockState(c);
  }, []);

  /** End the session (return to the login keypad) but keep the shift. */
  const signOut = useCallback(() => { remove(EMP_KEY); setEmployee(null); }, []);

  /** Record a clock-in (after a successful Time_Card post). */
  const setClock = useCallback((c: ClockState) => { saveJSON(CLOCK_KEY, c); setClockState(c); }, []);

  /** Clock out — ends the shift and the session (back to login). */
  const clockOut = useCallback(() => { remove(CLOCK_KEY); setClockState(null); remove(EMP_KEY); setEmployee(null); }, []);

  return { employee, clock, signIn, signOut, setClock, clockOut };
}
