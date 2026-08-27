/*
 * Activation — the POS enrolment chain (TerminalConfigManager.m), mirroring the
 * KDS flow that was proven live against enox:
 *   sign in (enterprise/user/pass) → New_Terminal token → pick store →
 *   pick terminal (POS-licensed) → Terminal_Assignment → Standard token → done.
 * On completion the caller kicks off the full definitions sync.
 */

import { useState } from "react";
import { requestNewTerminalToken, fetchStoreList, fetchTerminals, assignTerminal, requestStandardToken, type StorePick, type TerminalPick } from "@/protocol/activation";
import { entHost, ISIS_VER, type Settings } from "@/state/useSettings";

type Step = "login" | "store" | "terminal" | "confirm";

export default function Setup({ initial, onDone }: {
  initial: Settings;
  onDone: (patch: Partial<Settings>) => void;
}) {
  const [step, setStep] = useState<Step>("login");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [code, setCode] = useState(initial.enterpriseCode);
  const [user, setUser] = useState(initial.enterpriseUser);
  const [pass, setPass] = useState(initial.enterprisePassword);
  const [enrolToken, setEnrolToken] = useState("");
  const [stores, setStores] = useState<StorePick[]>([]);
  const [terminals, setTerminals] = useState<TerminalPick[]>([]);
  const [store, setStore] = useState<StorePick | null>(null);

  const url = () => entHost(code);

  const signIn = async () => {
    setErr(""); setBusy(true);
    try {
      const t = await requestNewTerminalToken({
        enterpriseServerUrl: url(), isisVer: ISIS_VER, terminalUID: initial.terminalUid,
        enterpriseCode: code.trim(), login: user.trim(), password: pass,
      });
      if (!t.ok) { setErr(t.error ?? "sign-in failed"); return; }
      setEnrolToken(t.token);
      const list = await fetchStoreList({ enterpriseServerUrl: url(), isisVer: ISIS_VER, enterpriseUser: user.trim(), enterpriseCode: code.trim(), token: t.token });
      if (!list.length) { setErr("No stores in the response — check credentials."); return; }
      setStores(list); setStep("store");
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  const pickStore = async (s: StorePick) => {
    setErr(""); setBusy(true); setStore(s);
    try {
      const list = await fetchTerminals({ enterpriseServerUrl: url(), isisVer: ISIS_VER, storeId: s.id, token: enrolToken });
      if (!list.length) { setErr("No POS-licensed terminals in this store."); return; }
      setTerminals(list); setStep("terminal");
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  const pickTerminal = async (t: TerminalPick) => {
    if (!store) return;
    setErr(""); setBusy(true);
    try {
      const asg = await assignTerminal({
        enterpriseServerUrl: url(), isisVer: ISIS_VER, storeId: store.id, token: enrolToken,
        terminalPosId: t.id, terminalUID: initial.terminalUid, authorizingUser: user.trim(),
      });
      if (!asg.ok) { setErr(asg.error ?? "assignment failed"); return; }
      const std = await requestStandardToken({
        enterpriseServerUrl: url(), isisVer: ISIS_VER, storeId: store.id, terminalPosId: t.id,
        terminalUID: initial.terminalUid, enterpriseCode: code.trim(),
      });
      if (!std.ok) { setErr(std.error ?? "session token failed"); return; }
      onDone({
        enterpriseServerUrl: url(), enterpriseCode: code.trim(), enterpriseUser: user.trim(), enterprisePassword: pass,
        storeId: store.id, storeName: store.name, terminalPosId: t.id, terminalName: t.name,
        token: std.token, activated: true,
      });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  if (step === "login") {
    return (
      <div className="activate">
        <div className="actbox">
          <div className="actbrand">Aireus</div>
          <div className="actrule" />
          <div className="acttitle">Activate this terminal.</div>
          <div className="actsub">Sign in with your enterprise credentials.</div>
          <div className="actfields">
            <label className="fld"><span>User name</span><input value={user} onChange={(e) => setUser(e.target.value)} autoFocus /></label>
            <label className="fld"><span>Password</span><input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            <label className="fld"><span>Enterprise</span><input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && code && user && !busy) void signIn(); }} /></label>
          </div>
          {code.trim() && <p className="hint">→ {url()}</p>}
          <button className="actsignin" disabled={busy || !code || !user} onClick={() => void signIn()}>{busy ? "…" : "SIGN IN"}</button>
          {err && <p className="status err">{err}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <h1>Aireus</h1>
      {step === "store" && (
        <div className="card">
          <h2>Choose store</h2>
          {stores.map((s) => <button key={s.id} disabled={busy} onClick={() => void pickStore(s)}>{s.name} · {s.id}</button>)}
          <button className="ghost" onClick={() => setStep("login")}>Back</button>
        </div>
      )}
      {step === "terminal" && (
        <div className="card">
          <h2>Choose terminal</h2>
          <p className="hint">POS-licensed terminals in {store?.name}</p>
          {terminals.map((t) => <button key={t.id} disabled={busy} onClick={() => void pickTerminal(t)}>{t.name} · {t.id}</button>)}
          <button className="ghost" onClick={() => setStep("store")}>Back</button>
        </div>
      )}
      {err && <p className="status err">{err}</p>}
    </div>
  );
}
