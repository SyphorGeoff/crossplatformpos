/*
 * Employee PIN login — the sign-in keypad after activation, faithful to the iOS
 * ISIS client (LoginViewController/LoginManager). ONE masked keypad, TWO
 * sequential entries: (1) type Emp_POS_ID, Ent → exact local match against the
 * Employee table; (2) type PIN, Ent → entered === employee.Pin (exact equality).
 * Purely local (no server call). If the store doesn't use PINs, ID alone logs
 * in. Errors reset to the ID step.
 *
 * Strings/layout mirror the iOS screen: "Enter ID Followed by Security / PIN",
 * keypad 7 8 9 / 4 5 6 / 1 2 3 / 0 Del Ent, version bottom-left, terminal name
 * bottom-right, tagline centered (baked into the iOS background art; text here
 * since we render vector, not PNGs).
 */

import { useState } from "react";
import type { Settings } from "@/state/useSettings";

export interface LoginEmployee { id: string; name: string; pin: string; }
const TAGLINE = "All new ways to do completely new things";

export default function Login({ settings, lookup, usePin, onLogin }: {
  settings: Settings;
  lookup: (id: string) => LoginEmployee | null;
  usePin: boolean;
  onLogin: (emp: { id: string; name: string }) => void;
}) {
  const [phase, setPhase] = useState<"id" | "pin">("id");
  const [entry, setEntry] = useState("");
  const [emp, setEmp] = useState<LoginEmployee | null>(null);
  const [error, setError] = useState("");

  const reset = () => { setPhase("id"); setEntry(""); setEmp(null); };

  const enter = () => {
    if (!entry) return;
    if (phase === "id") {
      const found = lookup(entry);
      if (!found) { setError("Invalid ID"); setEntry(""); return; }
      setError("");
      if (!usePin) { onLogin({ id: found.id, name: found.name }); reset(); return; }
      setEmp(found); setPhase("pin"); setEntry("");
    } else if (emp) {
      if (entry === emp.pin) { onLogin({ id: emp.id, name: emp.name }); reset(); }
      else { setError("Invalid Pin"); reset(); }
    }
  };

  const press = (k: string) => {
    setError("");
    if (k === "Del") setEntry((e) => e.slice(0, -1));
    else if (k === "Ent") enter();
    else setEntry((e) => (e + k).slice(0, 12));
  };
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "Del", "Ent"];

  return (
    <div className="login">
      <div className="loginhead">AIREUS</div>
      <div className="loginpad">
        <div className="loginentry">{entry ? entry.replace(/./g, "•") : " "}</div>
        <div className="loginkeys">
          {keys.map((k) => (
            <button key={k} className={`lkey ${k === "Del" || k === "Ent" ? "word" : ""}`} onClick={() => press(k)}>{k}</button>
          ))}
        </div>
        {error
          ? <div className="loginerr">{error}</div>
          : phase === "pin"
            ? <div className="loginprompt">{emp?.name}<br />Enter Security PIN</div>
            : <div className="loginprompt">Enter ID Followed by Security<br />PIN</div>}
      </div>
      <div className="loginfoot">
        <span className="lver">ver 1.0.0</span>
        <span className="ltag">{TAGLINE}</span>
        <span className="lterm">{settings.terminalName || settings.terminalPosId}</span>
      </div>
    </div>
  );
}
