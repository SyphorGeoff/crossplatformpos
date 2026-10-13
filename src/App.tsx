/*
 * Aireus POS — shell. Milestone spine: activation → definitions sync. Once
 * activated, the app runs the full definitions sync and reports progress; the
 * real POS screens (menu browse = M1) land next. This proves the whole
 * activation chain + sync against a live server end to end.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Setup from "./views/Setup";
import Menu from "./views/Menu";
import { ISIS_VER, useSettings } from "./state/useSettings";
import { DefinitionError, fullSync, loadSeqMap, incrementalSync, type SyncConfig } from "./protocol/defsync";
import { requestStandardToken } from "./protocol/activation";

export default function App() {
  const { settings, update } = useSettings();
  // With a cache the keypad shows at once and the launch refresh runs behind it;
  // with no cache the loading screen shows until the full load is done.
  const [phase, setPhase] = useState<"idle" | "syncing" | "ready">(() =>
    settings.activated ? (Object.keys(loadSeqMap()).length > 0 ? "ready" : "syncing") : "idle");
  const [line, setLine] = useState("");
  const started = useRef(false);
  // Definitions refresh (iOS parity): full pull when there is no cache; otherwise
  // the revision-based incremental pull runs at launch AND every time the login
  // keypad appears (LoginViewController viewDidAppear → updatedDefinitionsLogin:YES),
  // plus manually from the terminal name on the keypad (pressTerminalName →
  // updateDefinitions). Changed tables bump defsVersion so Menu rebuilds its catalog.
  const [defsVersion, setDefsVersion] = useState(0);
  const tokenRef = useRef(settings.token);
  // Gate for every later definitions pull: resolved once the launch flow (fresh
  // token + sync) has finished. Created up front because Menu mounts — and its
  // keypad pull fires — before this component's own effects run; a pull that
  // ran early used the stale stored token, got "Invalid Token", re-minted, and
  // (one Standard token per terminal) invalidated the launch sync's token mid-run.
  const [launch] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  });
  const lastSyncAt = useRef(0);

  const syncCfg = useCallback((): SyncConfig => ({
    enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
    storeId: settings.storeId, token: tokenRef.current,
  }), [settings.enterpriseServerUrl, settings.storeId]);

  // On activation: refresh the daily session token, then full sync if never
  // synced, else incremental (launch refresh).
  useEffect(() => {
    if (!settings.activated || started.current) return;
    started.current = true;
    const hasData = Object.keys(loadSeqMap()).length > 0;
    void (async () => {
      // The Standard session token minted at activation expires (daily) — every
      // live call needs a valid one, so re-request it at launch, the way iOS does
      // (getStandardToken). No credentials required: store/terminal/UID/code
      // identify the licensed terminal. Falls back to the stored token offline.
      const tok = await requestStandardToken({
        enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
        storeId: settings.storeId, terminalPosId: settings.terminalPosId,
        terminalUID: settings.terminalUid, enterpriseCode: settings.enterpriseCode,
      });
      console.info("[defsync] launch: standard token minted", tok.ok ? "ok" : `FAILED ${tok.error ?? ""}`);
      if (tok.ok && tok.token) { tokenRef.current = tok.token; update({ token: tok.token }); }
      const onProg = (name: string, i: number, total: number, rows: number) => setLine(`${name} (${i + 1}/${total}) — ${rows} rows`);
      try {
        if (hasData) { const changed = await incrementalSync(syncCfg(), onProg); if (changed.length) setDefsVersion((v) => v + 1); }
        else { await fullSync(syncCfg(), onProg); setDefsVersion((v) => v + 1); }
        lastSyncAt.current = Date.now();
      } catch (e) { console.warn("[defsync] launch sync failed — using cache:", e); setLine(`Sync error: ${String((e as Error).message ?? e)} — using cache`); }
      setPhase("ready");
      launch.resolve();
    })();
  }, [settings.activated]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Revision-based pull of any table the server has moved past our cache.
   *  Waits for the launch flow (fresh token) first; a pull that just ran at
   *  launch is not repeated. Returns the definition names that changed. */
  const refreshDefinitions = useCallback(async (force = false): Promise<string[]> => {
    await launch.promise;
    if (!force && Date.now() - lastSyncAt.current < 5000) return [];
    let changed: string[];
    try {
      changed = await incrementalSync(syncCfg());
    } catch (e) {
      // The daily Standard token can lapse while the terminal sits on the keypad:
      // re-mint it once (getStandardToken) and retry; any other error keeps the cache.
      if (!(e instanceof DefinitionError && e.statusCode === "400")) throw e;
      const tok = await requestStandardToken({
        enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
        storeId: settings.storeId, terminalPosId: settings.terminalPosId,
        terminalUID: settings.terminalUid, enterpriseCode: settings.enterpriseCode,
      });
      console.info("[defsync] keypad refresh: token lapsed, re-minted", tok.ok ? "ok" : "FAILED");
      if (!tok.ok || !tok.token) throw e;
      tokenRef.current = tok.token; update({ token: tok.token });
      changed = await incrementalSync(syncCfg());
    }
    lastSyncAt.current = Date.now();
    if (changed.length) setDefsVersion((v) => v + 1);
    return changed;
  }, [launch, syncCfg, settings.enterpriseServerUrl, settings.storeId, settings.terminalPosId, settings.terminalUid, settings.enterpriseCode, update]);

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

  return (
    <Menu
      settings={settings}
      defsVersion={defsVersion}
      refreshDefinitions={refreshDefinitions}
      onChangeStation={() => update({ activated: false, token: "" })}
    />
  );
}
