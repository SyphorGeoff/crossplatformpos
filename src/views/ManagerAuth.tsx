/*
 * Manager authorization — a PIN prompt for a restricted action. The entered PIN
 * must resolve to an employee whose job grants `action` (findAuthorizer, local
 * validation, ManagerAuthViewController.m). On success the authorizing employee
 * is returned so it can ride as AuthorizingEmployee_ID on the wire.
 */

import { useState } from "react";
import { findAuthorizer, type AuthAction, type Authorizer } from "@/model/permissions";

export default function ManagerAuth({ title, action, onAuthorized, onCancel }: {
  title: string;
  action: AuthAction;
  onAuthorized: (emp: Authorizer) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    const a = findAuthorizer(pin, action);
    if (a) onAuthorized(a);
    else { setErr("Not authorized"); setPin(""); }
  };
  const key = (k: string) => { setErr(""); setPin((p) => (p + k).slice(0, 8)); };

  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="authbox" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">{title}</div>
        <div className="authsub">Manager PIN required</div>
        <div className="authpin">{pin.replace(/./g, "•") || " "}</div>
        {err && <div className="autherr">{err}</div>}
        <div className="keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((k) => (
            <button key={k} className="kkey" onClick={() => (k === "⌫" ? setPin((p) => p.slice(0, -1)) : k === "OK" ? submit() : key(k))}>{k}</button>
          ))}
        </div>
        <button className="mfbtn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
