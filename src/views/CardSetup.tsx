/*
 * Card setup — the per-terminal side of the Stripe processor: the reader this
 * tablet drives when the Terminal definition's TyroTerminalID is empty, and a
 * check that the back-office credentials work. Credentials themselves live in
 * the back office (Credit Card interface) and are never entered here. Test mode
 * adds "Create simulated reader" so the whole flow runs before a device arrives.
 * Manager-only (gated upstream). Presentation + the setup calls in stripe.ts.
 */

import { useEffect, useState } from "react";
import type { ProcessorConfig } from "@/payments/config";
import {
  checkStripeKey, getReader, hasStripeKey, listReaders, registerReader, setStripeLocalReader, SIMULATED_READER_CODE, stripeAccountLabel, stripeKey, stripeKeyMode, stripeLocalReader, type ReaderInfo,
} from "@/payments/stripe";

export interface CardSetupProps {
  config: ProcessorConfig;
  terminalReaderId: string;   // Terminal TyroTerminalID from the definitions ("" = none)
  onClose: () => void;
}

export default function CardSetup(p: CardSetupProps) {
  const hasKey = hasStripeKey(p.config);
  const keyMode = stripeKeyMode(stripeKey(p.config));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [localReader, setLocalReader] = useState(stripeLocalReader());
  const [pairing, setPairing] = useState("");
  const [readers, setReaders] = useState<ReaderInfo[] | null>(null);
  const [live, setLive] = useState<ReaderInfo | null>(null);

  const effectiveReader = p.terminalReaderId || localReader;
  const mode = p.config.testMode ? "test" : "live";

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true); setStatus(`${label}…`);
    try { setStatus(await fn()); } catch (e) { setStatus(`${label} failed: ${String((e as Error).message ?? e)}`); }
    setBusy(false);
  };

  useEffect(() => {
    if (!hasKey || !effectiveReader) { setLive(null); return; }
    let on = true;
    void getReader(p.config, effectiveReader).then((r) => { if (on) setLive(r.ok ? r.reader : null); });
    return () => { on = false; };
  }, [hasKey, effectiveReader, p.config]);

  const testKey = () => run("Checking credentials", async () => (await checkStripeKey(p.config)).message);

  const createSimulated = () => run("Creating simulated reader", async () => {
    const r = await registerReader(p.config, SIMULATED_READER_CODE, "Simulated reader");
    if (!r.ok) return r.message;
    setStripeLocalReader(r.reader.id); setLocalReader(r.reader.id);
    return `Simulated reader ${r.reader.id} created and assigned to this terminal`;
  });

  const register = () => run("Registering reader", async () => {
    if (!pairing.trim()) return "Enter the pairing code shown on the reader";
    const r = await registerReader(p.config, pairing, "Terminal reader");
    if (!r.ok) return r.message;
    setStripeLocalReader(r.reader.id); setLocalReader(r.reader.id); setPairing("");
    return `Reader ${r.reader.id} (${r.reader.deviceType}) registered. Put it in the back office Terminal → TyroTerminalID to make it permanent.`;
  });

  const loadReaders = () => run("Listing readers", async () => {
    const r = await listReaders(p.config);
    if (!r.ok) return r.message;
    setReaders(r.readers);
    return r.readers.length ? `${r.readers.length} reader(s)` : "No readers on this account/location yet";
  });

  const pick = (id: string) => { setStripeLocalReader(id); setLocalReader(id); setStatus(`Reader ${id} assigned to this terminal`); };
  const clearLocal = () => { setStripeLocalReader(""); setLocalReader(""); setStatus("Terminal-local reader cleared"); };

  return (
    <div className="backdrop" onClick={busy ? undefined : p.onClose}>
      <div className="mgrpanel" onClick={(e) => e.stopPropagation()}>
        <div className="mgrhead">
          <div><div className="mgrtitle">Card setup · Stripe</div><div className="mgrsub">{mode} mode · {stripeAccountLabel(p.config)}</div></div>
          <button className="x" onClick={p.onClose} disabled={busy}>✕</button>
        </div>
        {status && <div className="mgrstatus">{status}</div>}

        <div className="mgrlist">
          <div className="mgrlabel">Credentials (back office → Credit Card interface)</div>
          <div className="mgrrow" style={{ cursor: "default" }}>
            {hasKey ? `Secret key present (${keyMode || "unknown"} mode)` : "No secret key"}
            <span>{hasKey ? (keyMode && (keyMode === "test") !== p.config.testMode ? `does not match the store's ${mode} mode` : "from the Store definition") : "enter it in the back office, then re-pull definitions"}</span>
          </div>
          <div className="pvactions">
            <button className="mfbtn ghost" disabled={busy || !hasKey} onClick={testKey}>Test credentials</button>
          </div>
        </div>

        <div className="mgrlist">
          <div className="mgrlabel">Reader</div>
          <div className="mgrrow" style={{ cursor: "default" }}>
            {effectiveReader || "None assigned"}
            <span>{p.terminalReaderId ? "from Terminal TyroTerminalID" : localReader ? "terminal-local" : "set TyroTerminalID or register below"}</span>
          </div>
          {live && <div className="mgrsub">{live.label || live.deviceType} · {live.deviceType} · {live.status || "status unknown"}{live.actionStatus ? ` · last action ${live.actionType} ${live.actionStatus}` : ""}</div>}
          <label className="fld"><span>Pairing code</span><input value={pairing} onChange={(e) => setPairing(e.target.value)} placeholder="shown on the reader" autoComplete="off" /></label>
          <div className="pvactions">
            <button className="mfbtn" disabled={busy || !hasKey || !pairing.trim()} onClick={register}>Register reader</button>
            <button className="mfbtn ghost" disabled={busy || !hasKey} onClick={loadReaders}>List readers</button>
            {p.config.testMode && <button className="mfbtn ghost" disabled={busy || !hasKey} onClick={createSimulated}>Create simulated reader</button>}
            {localReader && !p.terminalReaderId && <button className="mfbtn ghost" disabled={busy} onClick={clearLocal}>Clear local</button>}
          </div>
          {readers && readers.map((r) => (
            <button key={r.id} className="mgrrow" disabled={busy} onClick={() => pick(r.id)}>
              {r.label || r.id}<span>{r.deviceType} · {r.status || "?"} · {r.id}</span>
            </button>
          ))}
          <button className="mfbtn ghost" onClick={p.onClose} disabled={busy}>Done</button>
        </div>
      </div>
    </div>
  );
}
