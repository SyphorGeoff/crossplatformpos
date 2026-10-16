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

import { useEffect, useRef, useState } from "react";
import { ISIS_VER, type Settings } from "@/state/useSettings";
import { loadJSON, saveJSON } from "@/platform/storage";
import { clearBroadcast, fetchBroadcasts, type BroadcastNotice } from "@/protocol/messaging";
import { checkForUpdate, installUpdate, installedVersion, reopenInstaller, type InstalledVersion, type UpdateInfo } from "@/platform/appupdate";

export interface LoginEmployee { id: string; name: string; pin: string; }
const TAGLINE = "All new ways to do completely new things";

export default function Login({ settings, lookup, usePin, onLogin, status = "", onTerminalName, isManager = () => false }: {
  settings: Settings;
  lookup: (id: string) => LoginEmployee | null;
  usePin: boolean;
  onLogin: (emp: { id: string; name: string }) => void;
  /** Mgr_Menu job holder? The in-app Update is shielded by a manager ID + PIN on this keypad. */
  isManager?: (empId: string) => boolean;
  /** Definitions-refresh status shown under the prompt (iOS "updating" overlay). */
  status?: string;
  /** iOS pressTerminalName: the terminal name re-pulls definitions by hand. */
  onTerminalName?: () => void;
}) {
  const [phase, setPhase] = useState<"id" | "pin">("id");

  // Kitchen Board (messaging arc F4, approved mock 2026-10-16): the store's live
  // broadcasts beside the keypad. Polled every 10 s while the keypad is up — the
  // full tiny list each time. Clear hides a notice on THIS terminal only (a local
  // cleared-ID set, pruned to what the server still lists, so it never grows) and
  // tells the server once; the server records the first terminal to clear and the
  // KDS shows "Seen" once. Expiry / the kitchen's Take down just drop it from the list.
  const BOARD_MS = 10_000;
  const CLEARED_KEY = "board.cleared.v1";
  const [board, setBoard] = useState<BroadcastNotice[]>([]);
  const cleared = useRef<Set<string>>(new Set(loadJSON<string[]>(CLEARED_KEY, [])));
  const boardCfg = () => ({ enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER, storeId: settings.storeId, token: settings.token, terminalPosId: settings.terminalPosId });
  useEffect(() => {
    if (!settings.activated || !settings.token) return;
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const list = await fetchBroadcasts(boardCfg());
        if (!alive) return;
        const live = new Set(list.map((n) => n.id));
        for (const id of [...cleared.current]) if (!live.has(id)) cleared.current.delete(id);
        saveJSON(CLEARED_KEY, [...cleared.current]);
        setBoard(list);
      } catch { /* keep the last list */ }
      finally { busy = false; }
    };
    void tick();
    const t = window.setInterval(() => { void tick(); }, BOARD_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [settings.activated, settings.token, settings.storeId, settings.enterpriseServerUrl, settings.terminalPosId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = board.filter((n) => !cleared.current.has(n.id));
  const clearNotice = (id: string) => {
    cleared.current.add(id); saveJSON(CLEARED_KEY, [...cleared.current]);
    setBoard((b) => [...b]); // re-render
    void clearBroadcast(boardCfg(), id);
  };
  const noticeFrom = (n: BroadcastNotice): string => {
    if (n.fromName) { const [l, f] = n.fromName.split(","); return `${(f ?? "").trim()} ${(l ?? "").trim()}`.trim(); }
    if (n.fromEmpId) { const e = lookup(n.fromEmpId); if (e) return e.name; }
    return n.terminalPosId ? `Kitchen · ${n.terminalPosId}` : "Kitchen";
  };
  const hhmm = (s: string) => (s && s.length >= 16 ? s.slice(11, 16) : s);
  const [entry, setEntry] = useState("");
  const [emp, setEmp] = useState<LoginEmployee | null>(null);
  const [error, setError] = useState("");

  // In-app update (Android native only): every arrival at the keypad asks the
  // enterprise server's UpdateKit for a newer build; the version shown is the
  // installed native build. iOS / web: no plugin → nothing shows.
  const [installed, setInstalled] = useState<InstalledVersion | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updStatus, setUpdStatus] = useState("");
  // Full-screen progress from the moment the credentials pass until Android's own
  // install sheet takes over (a silent download invites repeat taps).
  const [progress, setProgress] = useState<{ pct: number | null; note: string; failed?: boolean } | null>(null);
  const [checkTick, setCheckTick] = useState(0); // bumped by the terminal-name press → re-check
  useEffect(() => {
    let alive = true;
    void installedVersion().then((v) => { if (alive) setInstalled(v); });
    void checkForUpdate(settings.enterpriseServerUrl).then((r) => {
      if (!alive) return;
      setUpdate(r.update);
      if (r.problem) setUpdStatus(`Update check failed: ${r.problem}`);
    });
    return () => { alive = false; };
  }, [settings.enterpriseServerUrl, checkTick]);
  // The Update pill opens its OWN small ID + PIN modal (never the sign-in keypad,
  // never signs anyone in, always asks the PIN), then the progress modal.
  const [authOpen, setAuthOpen] = useState(false);
  const [authPhase, setAuthPhase] = useState<"id" | "pin">("id");
  const [authId, setAuthId] = useState("");
  const [authEntry, setAuthEntry] = useState("");
  const [authError, setAuthError] = useState("");
  const askUpdate = () => { setAuthPhase("id"); setAuthId(""); setAuthEntry(""); setAuthError(""); setUpdStatus(""); setAuthOpen(true); };
  const authPress = (k: string) => {
    setAuthError("");
    if (k === "Del") { setAuthEntry((e) => e.slice(0, -1)); return; }
    if (k !== "Ent") { setAuthEntry((e) => (e + k).slice(0, 12)); return; }
    if (!authEntry) return;
    if (authPhase === "id") {
      if (!lookup(authEntry)) { setAuthError("Invalid ID"); setAuthEntry(""); return; }
      setAuthId(authEntry); setAuthEntry(""); setAuthPhase("pin"); return;
    }
    const found = lookup(authId);
    if (!found || authEntry !== found.pin) { setAuthError("Invalid PIN"); setAuthPhase("id"); setAuthId(""); setAuthEntry(""); return; }
    if (!isManager(found.id)) { setAuthError("Manager required"); setAuthPhase("id"); setAuthId(""); setAuthEntry(""); return; }
    setAuthOpen(false);
    void doUpdate();
  };
  const doUpdate = async () => {
    if (!update || progress) return;
    setUpdStatus("");
    setProgress({ pct: null, note: "Starting download…" });
    const r = await installUpdate(update, (pct) => setProgress({ pct, note: "Downloading…" }));
    if (r.outcome === "installing") setProgress({ pct: 100, note: "Downloaded. Android will now ask to install — tap Install / Update on its sheet." });
    else if (r.outcome === "permission") setProgress({ pct: null, note: "Allow installs from Aireus POS on the Android page that opened, then tap Update again.", failed: true });
    else setProgress({ pct: null, note: `Update failed: ${r.message ?? ""}`, failed: true });
  };

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

  const progressModal = progress && update ? (
    <div className="backdrop">
      <div className="authbox">
        <div className="authtitle">Updating to {update.versionName}</div>
        <div className="updbig">{progress.pct === null ? "…" : `${progress.pct}%`}</div>
        <div className="authsub">{progress.note}</div>
        {progress.pct === 100 && !progress.failed && (
          <div className="mfactions">
            <button className="mfbtn ghost" onClick={() => setProgress(null)}>Cancel</button>
            <button className="mfbtn go" onClick={() => void reopenInstaller().then((err) => { if (err) setProgress({ pct: null, note: `Installer: ${err}`, failed: true }); })}>Open installer</button>
          </div>
        )}
        {progress.failed && <div className="mfactions"><button className="mfbtn go" onClick={() => setProgress(null)}>OK</button></div>}
      </div>
    </div>
  ) : null;

  const authModal = authOpen && update ? (
    <div className="backdrop" onClick={() => setAuthOpen(false)}>
      <div className="authbox updauth" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">Update to {update.versionName}</div>
        <div className="authsub">{authPhase === "id" ? "Manager ID, then Ent" : `PIN for ${lookup(authId)?.name ?? authId}, then Ent`}</div>
        <div className="loginentry small">{authEntry ? authEntry.replace(/./g, "•") : " "}</div>
        {authError && <div className="loginerr">{authError}</div>}
        <div className="loginkeys small">
          {keys.map((k) => (
            <button key={k} className={`lkey ${k === "Del" || k === "Ent" ? "word" : ""}`} onClick={() => authPress(k)}>{k}</button>
          ))}
        </div>
        <div className="mfactions"><button className="mfbtn ghost" onClick={() => setAuthOpen(false)}>Cancel</button></div>
      </div>
    </div>
  ) : null;

  return (
    <div className="login">
      {progressModal}
      {authModal}
      <div className="loginhead">AIREUS</div>
      <div className="loginbody">
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
        {status ? <div className="loginstatus">{status}</div> : null}
        {updStatus ? <div className="loginstatus">{updStatus}</div> : null}
      </div>
      {shown.length > 0 && (
        <aside className="bulletin">
          <div className="bhead"><h2>Kitchen Board</h2><span>{shown.length} notice{shown.length === 1 ? "" : "s"}</span></div>
          {shown.map((n) => (
            <div key={n.id} className={`bitem ${/^86\b/i.test(n.subject) || /^86\b/i.test(n.body) ? "hot" : ""}`}>
              <div className="bfrom">{noticeFrom(n)}</div><div className="btime">{hhmm(n.sentOn)}</div>
              <div className="btext">{n.body || n.subject}</div>
              <button className="bclear" onClick={() => clearNotice(n.id)}>Clear</button>
            </div>
          ))}
          <div className="bexp">Notices clear themselves after 10 minutes</div>
        </aside>
      )}
      </div>
      <div className="loginfoot">
        <span className="lver">
          {installed ? `v${installed.versionName}` : "ver 1.0.0"}
          {update ? <button className="lupd" disabled={!!progress && !progress.failed} onClick={askUpdate}>Update to {update.versionName}</button> : null}
        </span>
        <span className="ltag">{TAGLINE}</span>
        <span className="lterm" onClick={() => { setCheckTick((t) => t + 1); onTerminalName?.(); }} role={onTerminalName ? "button" : undefined}>{settings.terminalName || settings.terminalPosId}</span>
      </div>
    </div>
  );
}
