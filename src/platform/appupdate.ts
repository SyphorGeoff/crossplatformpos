/*
 * In-app update seam (Android native builds only). The AppUpdate Capacitor plugin
 * (native/android/AppUpdatePlugin.java) reports the installed version, checks the
 * "install unknown apps" permission, downloads an APK and hands it to the Android
 * package installer. iOS cannot install from inside an app and the web is updated
 * by a page reload, so canSelfUpdate() is false there and the button never shows.
 *
 * Server side: <enterprise server>/UpdateKit/pos-version.json
 *   { "versionCode": 5, "versionName": "1.4", "url": "aireus-pos.apk" }
 * url may be relative to UpdateKit/ or absolute. An update is offered when the
 * server's versionCode is above the installed one.
 */

import { capacitor, httpRequest, isNative } from "./http";

export interface InstalledVersion { versionCode: number; versionName: string; }
export interface UpdateInfo extends InstalledVersion { url: string; }

interface AppUpdatePlugin {
  getVersion(): Promise<InstalledVersion>;
  canInstall(): Promise<{ ok: boolean }>;
  requestInstallPermission(): Promise<void>;
  install(opts: { url: string }): Promise<{ ok: boolean }>;
  addListener(event: "progress", cb: (e: { pct: number }) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

const plugin = (): AppUpdatePlugin | undefined => capacitor()?.Plugins?.AppUpdate as AppUpdatePlugin | undefined;

/** True only on the Android native build with the plugin compiled in. */
export function canSelfUpdate(): boolean {
  return isNative() && capacitor()?.getPlatform?.() === "android" && !!plugin();
}

export async function installedVersion(): Promise<InstalledVersion | null> {
  const p = plugin();
  if (!p) return null;
  try { return await p.getVersion(); } catch { return null; }
}

const updateKitBase = (enterpriseServerUrl: string): string => `${enterpriseServerUrl.replace(/\/+$/, "")}/UpdateKit/`;
export const updateManifestUrl = (enterpriseServerUrl: string): string => `${updateKitBase(enterpriseServerUrl)}pos-version.json`;

/** The newer build the server offers, or null (up to date / not native / unreachable). */
export async function checkForUpdate(enterpriseServerUrl: string): Promise<UpdateInfo | null> {
  if (!canSelfUpdate() || !enterpriseServerUrl) return null;
  const cur = await installedVersion();
  if (!cur) return null;
  try {
    const res = await httpRequest(updateManifestUrl(enterpriseServerUrl));
    if (!res.ok) return null;
    const j = JSON.parse(await res.text()) as Partial<UpdateInfo>;
    const code = Number(j.versionCode);
    if (!Number.isFinite(code) || code <= cur.versionCode || !j.url) return null;
    const url = /^https?:\/\//.test(j.url) ? j.url : updateKitBase(enterpriseServerUrl) + j.url;
    return { versionCode: code, versionName: String(j.versionName ?? code), url };
  } catch { return null; }
}

export type InstallOutcome = "installing" | "permission" | "failed";

/** Download and hand to the installer. "permission" = the user must first allow
 *  installs from this app (the system page was opened); tap Update again after. */
export async function installUpdate(info: UpdateInfo, onProgress?: (pct: number) => void): Promise<{ outcome: InstallOutcome; message?: string }> {
  const p = plugin();
  if (!p) return { outcome: "failed", message: "Not available on this platform" };
  try {
    if (!(await p.canInstall()).ok) { await p.requestInstallPermission(); return { outcome: "permission" }; }
    const sub = await Promise.resolve(p.addListener("progress", (e) => onProgress?.(e.pct)));
    try {
      const r = await p.install({ url: info.url });
      return r.ok ? { outcome: "installing" } : { outcome: "failed", message: "Installer did not open" };
    } finally { sub.remove(); }
  } catch (e) { return { outcome: "failed", message: String((e as Error).message ?? e) }; }
}
