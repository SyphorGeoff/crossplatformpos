/*
 * TEMPORARY (Geoff 2026-11-10) — save this terminal's payment device id to the
 * server through /ISISPOS/devicecode_cap.jsp, the page the iPad's Square
 * terminal pairing uses (AR_SquareCheckout saveDeviceCode). The page writes the
 * id to the terminal's Terminal ID in the back office (Terminal_In_Store
 * TyroTerminalID, matched by Store_ID + Terminal_UID) and bumps the Terminal
 * definition so terminals re-pull it.
 *
 * We do NOT want to depend on a JSP. Replace this call with the new API call
 * when it is available, then delete this file.
 */

import { httpRequest } from "@/platform/http";

export interface DeviceCodeConfig { enterpriseServerUrl: string; storeId: string; terminalUid: string; }

export function deviceCodeUrl(cfg: DeviceCodeConfig, deviceId: string): string {
  const q = (v: string) => encodeURIComponent(v.trim());
  return `${cfg.enterpriseServerUrl.replace(/\/$/, "")}/ISISPOS/devicecode_cap.jsp?Store_ID=${q(cfg.storeId)}&devicecode=${q(deviceId)}&terminaluid=${q(cfg.terminalUid)}`;
}

/** Save the device id against this terminal on the server. The page answers 200 with "devicecode saved OK" in the body. */
export async function saveDeviceId(cfg: DeviceCodeConfig, deviceId: string): Promise<{ ok: boolean; message: string }> {
  if (!cfg.storeId.trim() || !cfg.terminalUid.trim()) return { ok: false, message: "this terminal is not activated" };
  if (!deviceId.trim()) return { ok: false, message: "no device id to save" };
  try {
    const res = await httpRequest(deviceCodeUrl(cfg, deviceId), { method: "GET" });
    const text = await res.text();
    if (res.ok && /devicecode saved OK/i.test(text)) return { ok: true, message: "saved" };
    return { ok: false, message: res.ok ? "the server did not confirm the save" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "network error" };
  }
}
