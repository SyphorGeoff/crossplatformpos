/*
 * Aireus POS — shell. Milestone spine: activation → definitions sync. Once
 * activated, the app runs the full definitions sync and reports progress; the
 * real POS screens (menu browse = M1) land next. This proves the whole
 * activation chain + sync against a live server end to end.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Setup from "./views/Setup";
import { ISIS_VER, useSettings } from "./state/useSettings";
import { fullSync, loadDefRows, loadSeqMap, incrementalSync, type SyncConfig } from "./protocol/defsync";
import { DEFINITIONS } from "./model/definitions";

export default function App() {
  const { settings, update } = useSettings();
  const [phase, setPhase] = useState<"idle" | "syncing" | "ready">("idle");
  const [line, setLine] = useState("");
  const [counts, setCounts] = useState<{ table: string; rows: number }[]>([]);
  const started = useRef(false);

  const cfg = useCallback((): SyncConfig => ({
    enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
    storeId: settings.storeId, token: settings.token,
  }), [settings]);

  const refreshCounts = useCallback(() => {
    setCounts(DEFINITIONS.map((d) => ({ table: d.table, rows: loadDefRows(d.table).length })).filter((c) => c.rows > 0));
  }, []);

  // On activation: full sync if never synced, else incremental (launch refresh).
  useEffect(() => {
    if (!settings.activated || started.current) return;
    started.current = true;
    const hasData = Object.keys(loadSeqMap()).length > 0;
    setPhase("syncing");
    void (async () => {
      const onProg = (name: string, i: number, total: number, rows: number) => setLine(`${name} (${i + 1}/${total}) — ${rows} rows`);
      try {
        if (hasData) { setLine("Checking for changes…"); const changed = await incrementalSync(cfg(), onProg); setLine(changed.length ? `Updated ${changed.length} definition(s)` : "Up to date"); }
        else { await fullSync(cfg(), onProg); }
      } catch (e) { setLine(`Sync error: ${String((e as Error).message ?? e)} — using cache`); }
      refreshCounts(); setPhase("ready");
    })();
  }, [settings.activated, cfg, refreshCounts]);

  if (!settings.activated) {
    return <Setup initial={settings} onDone={(patch) => update(patch)} />;
  }

  const total = counts.reduce((a, c) => a + c.rows, 0);
  return (
    <div className="setup">
      <h1>Aireus POS</h1>
      <div className="card">
        <p><b>{settings.storeName || settings.storeId}</b> · terminal {settings.terminalName || settings.terminalPosId}</p>
        {phase === "syncing" && <p className="status">Syncing definitions… {line}</p>}
        {phase === "ready" && (
          <>
            <p className="status">Definitions loaded: {counts.length} tables, {total} rows. {line}</p>
            <div className="deflist">
              {counts.slice(0, 60).map((c) => <span key={c.table} className="defchip">{c.table}: {c.rows}</span>)}
            </div>
            <p className="hint">Menu browse (M1) is the next milestone.</p>
          </>
        )}
        <button className="ghost" onClick={() => update({ activated: false, token: "" })}>Change station</button>
      </div>
    </div>
  );
}
