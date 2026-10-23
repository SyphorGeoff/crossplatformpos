/*
 * Session identity — who is signed in (Employee_POS_ID on the check) and their
 * clock-in state. The iOS flow gates ordering on clock-in: after PIN login the
 * employee confirms and clocks into a job before any check can be opened
 * (LoginConfirmViewController). We mirror that: `employee` is set at login,
 * `clock` only after the SERVER says the employee is clocked in (Clocked_In_Emps,
 * checked by the landing effect on every sign-in) or after a Time_Card clock-in
 * posted in this session.
 *
 * NOTHING here is persisted (Geoff 2026-10-23): a launch always starts at the
 * keypad, and the clock state is never trusted from storage — only from the server.
 * Sign-out ends the session; the shift lives on the server and is re-read at the
 * next sign-in, which is how sign-out and clock-out stay distinct.
 */

import { useCallback, useState } from "react";
import { remove } from "@/platform/storage";

export interface CurrentEmployee { id: string; name: string; }
export interface ClockState { empId: string; jobId: string; jobName: string; sequence: string; defaultRoomId: string; }

// Keys older builds wrote; cleared once so a restored session can never come back.
const LEGACY_KEYS = ["emp.current.v1", "emp.clock.v1"];

export function useEmployee() {
  const [employee, setEmployee] = useState<CurrentEmployee | null>(() => { for (const k of LEGACY_KEYS) remove(k); return null; });
  const [clock, setClockState] = useState<ClockState | null>(null);

  /** Keypad sign-in: the session starts with NO clock state — the server is asked next. */
  const signIn = useCallback((e: CurrentEmployee) => { setEmployee(e); setClockState(null); }, []);

  /** End the session (return to the login keypad). The shift stays on the server. */
  const signOut = useCallback(() => { setEmployee(null); setClockState(null); }, []);

  /** Record the shift for this session (from the server's Clocked_In_Emps or a successful Time_Card post). */
  const setClock = useCallback((c: ClockState) => { setClockState(c); }, []);

  /** Clock out — ends the shift and the session (back to login). */
  const clockOut = useCallback(() => { setClockState(null); setEmployee(null); }, []);

  return { employee, clock, signIn, signOut, setClock, clockOut };
}
