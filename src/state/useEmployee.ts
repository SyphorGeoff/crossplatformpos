/*
 * Signed-in server — who the order is attributed to (Employee_POS_ID on the
 * check). The iPad sets this from the Employee definition at PIN login
 * (LoginManager.m:841); no server-side clock-in is required to send. We keep it
 * light: a chosen employee persisted per device, cleared on "sign out".
 */

import { useCallback, useState } from "react";
import { loadJSON, remove, saveJSON } from "@/platform/storage";

export interface CurrentEmployee { id: string; name: string; }

const KEY = "emp.current.v1";

export function useEmployee() {
  const [employee, setEmployee] = useState<CurrentEmployee | null>(() => loadJSON<CurrentEmployee | null>(KEY, null));

  const signIn = useCallback((e: CurrentEmployee) => { saveJSON(KEY, e); setEmployee(e); }, []);
  const signOut = useCallback(() => { remove(KEY); setEmployee(null); }, []);

  return { employee, signIn, signOut };
}
