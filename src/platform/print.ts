/*
 * Print transport seam. The iPad opens a raw TCP socket to the printer on port
 * 9100 and writes CP1252 bytes, with primary→backup failover and a persistent
 * retry queue (PrintManager / ESCPOSCore / AR_PrintQueueManager). A browser
 * can't open TCP, so:
 *   native (Capacitor Android): the TcpPrint plugin does the raw send.
 *   HTTP/cloud printers (port 80/443/8080/8443): POST to the enterprise
 *     printserver.jsp (works in dev via the forwarder and on device).
 *   web dev, raw printer: no path — log and drop (on-site LAN printers aren't
 *     reachable from a dev box; the Android build reaches them directly).
 * KDS-flagged printers get their orders through the normal order flow, not a chit.
 */

import { capacitor, httpRequest, isNative } from "./http";
import type { Printer } from "@/model/printers";

export function canPrintDirect(): boolean {
  return isNative() && !!capacitor()?.Plugins?.TcpPrint;
}

/** Encode the job's chars as their low bytes (CP1252/latin1), then base64. */
function jobToB64(job: string): string {
  let bin = "";
  for (let i = 0; i < job.length; i++) bin += String.fromCharCode(job.charCodeAt(i) & 0xff);
  return btoa(bin);
}

interface TcpPrintPlugin { send(opts: { ip: string; port: number; dataB64: string }): Promise<{ ok: boolean }>; }

async function sendRaw(job: string, ip: string, port: number): Promise<boolean> {
  if (!ip) return false;
  const plugin = capacitor()?.Plugins?.TcpPrint as TcpPrintPlugin | undefined;
  if (isNative() && plugin) {
    try { return (await plugin.send({ ip, port: port || 9100, dataB64: jobToB64(job) })).ok; }
    catch { return false; }
  }
  // DEV: relay through the Vite raw-TCP print bridge (vite.config.ts) so a real
  // LAN printer can be driven from the browser. Prod web has no printer path.
  if (import.meta.env?.DEV) {
    // Optional test override: "apos.dev.printip" forces EVERY chit to one printer
    // IP (bench testing without touching enox). "apos.dev.printrelay" points at a
    // standalone unsandboxed relay (scripts/printrelay.mjs) when the Vite server's
    // built-in /__print can't reach the LAN (sandboxed dev server).
    let target = ip, relay = "/__print";
    try { const o = localStorage.getItem("apos.dev.printip"); if (o) target = o.trim(); } catch { /* ignore */ }
    try { const r = localStorage.getItem("apos.dev.printrelay"); if (r) relay = r.trim(); } catch { /* ignore */ }
    const sep = relay.includes("?") ? "&" : "?";
    try {
      const res = await fetch(`${relay}${sep}ip=${encodeURIComponent(target)}&port=${port || 9100}`, { method: "POST", body: jobToB64(job) });
      return res.ok;
    } catch { return false; }
  }
  return false;
}

async function sendHttpServer(job: string, printer: Printer, opts: { enterpriseCode?: string; storeId?: string; backupIp?: string }): Promise<boolean> {
  const url = `https://${(opts.enterpriseCode || "").toLowerCase()}.aireus.com:8443/ISISPOS/printserver.jsp`;
  // iOS UploadPrintJob: printjob is percent-encoded, prefixed with ESC ! ! (double
  // wide) and suffixed with LF×8 + GS V 0 (cut). Store/Printer/addresses identify
  // the target so the cloud print server relays it to the right device.
  const printjob = "%1B%21%21" + encodeURIComponent(job) + "%0A%0A%0A%0A%0A%0A%0A%0A%1D%56%00";
  const enc = encodeURIComponent;
  const body = `Store_ID=${enc(opts.storeId ?? "")}&Printer_ID=${enc(printer.id)}&printjob=${printjob}` +
    `&printeraddress=${enc(printer.address)}&backupprinteraddress=${enc(opts.backupIp ?? "")}`;
  try {
    const res = await httpRequest(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return res.ok;
  } catch { return false; }
}

export interface PrintOpts { enterpriseCode?: string; storeId?: string; backup?: Printer; }

/** Print `job` to `printer`, failing over to its backup. Returns whether any
 *  printer accepted it. KDS-flagged printers show the order from the posted
 *  check (server-fed) rather than printing paper, so they're not a paper target. */
export async function printTo(printer: Printer | undefined, job: string, opts: PrintOpts = {}): Promise<boolean> {
  if (!printer || !job) return false;
  if (printer.isKDS) return true; // the KDS renders the order from the FinancialCheck; no chit to print
  const ok = printer.isHttpServer
    ? await sendHttpServer(job, printer, { enterpriseCode: opts.enterpriseCode, storeId: opts.storeId, backupIp: opts.backup?.address })
    : await sendRaw(job, printer.address, printer.port);
  if (ok) return true;
  if (opts.backup && opts.backup.id !== printer.id) return printTo(opts.backup, job, { enterpriseCode: opts.enterpriseCode, storeId: opts.storeId });
  return false;
}
