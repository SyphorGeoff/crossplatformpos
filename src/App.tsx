/*
 * Aireus POS — shell. Milestone scaffold: activation (New_Terminal → store →
 * terminal → Standard token) + definitions sync are the spine being built
 * first (see POS_SPEC.md). This placeholder proves the toolchain and wires the
 * activation form; screens land per milestone (M1 menu browse next).
 */

import { useState } from "react";
import { requestNewTerminalToken } from "./protocol/activation";

const ISIS_VER = "ver 1.0.0";
const entHost = (code: string) => `https://${code.trim().toLowerCase()}.aireus.com`;

function mintUid(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export default function App() {
  const [code, setCode] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true); setStatus("Enrolling terminal…");
    const r = await requestNewTerminalToken({
      enterpriseServerUrl: entHost(code), isisVer: ISIS_VER, terminalUID: mintUid(),
      enterpriseCode: code.trim(), login: user.trim(), password: pass,
    });
    setBusy(false);
    setStatus(r.ok ? `Token acquired ✓ (${r.token.slice(0, 12)}…) — store/terminal pickers next` : `Failed: ${r.error}`);
  };

  return (
    <div className="setup">
      <h1>Aireus POS</h1>
      <div className="card">
        <label>Enterprise code<input value={code} onChange={(e) => setCode(e.target.value)} /></label>
        {code.trim() && <p className="hint">→ {entHost(code)}</p>}
        <label>Login<input value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label>Password<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        <button disabled={busy || !code || !user} onClick={() => void signIn()}>{busy ? "…" : "Sign in"}</button>
        {status && <p className="status">{status}</p>}
      </div>
    </div>
  );
}
