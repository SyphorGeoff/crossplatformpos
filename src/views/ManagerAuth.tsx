/*
 * Manager authorization — a restricted action the signed-in server can't perform
 * is cleared by another employee entering their ID, then their PIN
 * (ManagerAuthViewController: "Please enter your ID followed by your PIN"). The
 * authorizer must hold `action` (or be a manager). Two steps on one keypad: the
 * ID is shown, the PIN is masked. The authorizing employee is returned so it can
 * ride as AuthorizingEmployee_ID on the wire.
 */

import { useState } from "react";
import { authorizeById, type AuthAction, type Authorizer } from "@/model/permissions";

export default function ManagerAuth({ title, action, onAuthorized, onCancel }: {
  title: string;
  action: AuthAction;
  onAuthorized: (emp: Authorizer) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"id" | "pin">("id");
  const [id, setId] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");

  const entry = phase === "id" ? id : pin;
  const setEntry = phase === "id" ? setId : setPin;
  const press = (k: string) => { setErr(""); setEntry((v) => (v + k).slice(0, 10)); };
  const del = () => setEntry((v) => v.slice(0, -1));

  const submit = () => {
    if (phase === "id") {
      if (!id.trim()) return;      // wait for an ID; don't validate yet
      setPhase("pin"); setErr("");
      return;
    }
    if (!pin.trim()) return;       // wait for a PIN
    const a = authorizeById(id, pin, action);
    if (a) { onAuthorized(a); return; }
    // Either the ID or the PIN was wrong — one combined message, start over.
    setErr("Invalid credentials"); setId(""); setPin(""); setPhase("id");
  };

  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="authbox" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">{title}</div>
        <div className="authsub">{phase === "id" ? "Enter authorizing ID" : "Enter PIN"}</div>
        <div className="authpin">{(phase === "pin" ? entry.replace(/./g, "•") : entry) || " "}</div>
        {err && <div className="autherr">{err}</div>}
        <div className="keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((k) => (
            <button key={k} className="kkey" onClick={() => (k === "⌫" ? del() : k === "OK" ? submit() : press(k))}>{k}</button>
          ))}
        </div>
        <button className="mfbtn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
