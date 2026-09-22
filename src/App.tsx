/*
 * Aireus POS — shell. Milestone spine: activation → definitions sync. Once
 * activated, the app runs the full definitions sync and reports progress; the
 * real POS screens (menu browse = M1) land next. This proves the whole
 * activation chain + sync against a live server end to end.
 */

import { useEffect, useRef, useState } from "react";
import Setup from "./views/Setup";
import Menu from "./views/Menu";
import { ISIS_VER, useSettings } from "./state/useSettings";
import { fullSync, loadSeqMap, incrementalSync, type SyncConfig } from "./protocol/defsync";
import { requestStandardToken } from "./protocol/activation";

export default function App() {
  const { settings, update } = useSettings();
  const [phase, setPhase] = useState<"idle" | "syncing" | "ready">("idle");
  const [line, setLine] = useState("");
  const started = useRef(false);

  // On activation: refresh the daily session token, then full sync if never
  // synced, else incremental (launch refresh).
  useEffect(() => {
    if (!settings.activated || started.current) return;
    started.current = true;
    const hasData = Object.keys(loadSeqMap()).length > 0;
    setPhase(hasData ? "ready" : "syncing"); // with a cache, browse immediately; refresh in background
    void (async () => {
      // The Standard session token minted at activation expires (daily) — every
      // live call needs a valid one, so re-request it at launch, the way iOS does
      // (getStandardToken). No credentials required: store/terminal/UID/code
      // identify the licensed terminal. Falls back to the stored token offline.
      let token = settings.token;
      const tok = await requestStandardToken({
        enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
        storeId: settings.storeId, terminalPosId: settings.terminalPosId,
        terminalUID: settings.terminalUid, enterpriseCode: settings.enterpriseCode,
      });
      if (tok.ok && tok.token) { token = tok.token; update({ token }); }
      const syncCfg: SyncConfig = {
        enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
        storeId: settings.storeId, token,
      };
      const onProg = (name: string, i: number, total: number, rows: number) => setLine(`${name} (${i + 1}/${total}) — ${rows} rows`);
      try {
        if (hasData) { await incrementalSync(syncCfg, onProg); }
        else { await fullSync(syncCfg, onProg); }
      } catch (e) { setLine(`Sync error: ${String((e as Error).message ?? e)} — using cache`); }
      setPhase("ready");
    })();
  }, [settings.activated]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings.activated) {
    return <Setup initial={settings} onDone={(patch) => update(patch)} />;
  }

  if (phase === "syncing") {
    return (
      <div className="setup">
        <h1>Aireus POS</h1>
        <div className="card">
          <p><b>{settings.storeName || settings.storeId}</b> · terminal {settings.terminalName || settings.terminalPosId}</p>
          <p className="status">Loading menu… {line}</p>
        </div>
      </div>
    );
  }

  return <Menu settings={settings} onChangeStation={() => update({ activated: false, token: "" })} />;
}
