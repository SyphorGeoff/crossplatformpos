/*
 * POS station settings — persisted per device (the NSUserDefaults analog).
 * Identity is HBroker-owned: written by activation, not hand-edited.
 */

import { useCallback, useState } from "react";
import { loadJSON, saveJSON } from "@/platform/storage";

export const ISIS_VER = "ver 1.0.0";

export interface Settings {
  enterpriseServerUrl: string;
  enterpriseCode: string;
  enterpriseUser: string;
  enterprisePassword: string;
  storeId: string;
  storeName: string;
  terminalPosId: string;
  terminalName: string;
  terminalUid: string;   // persistent 10-digit device GUID (iSISAppDelegate.GUID)
  token: string;         // Standard session token
  activated: boolean;
}

const KEY = "settings.v1";

function mintUid(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 10);
  return s;
}

const DEFAULTS: Settings = {
  enterpriseServerUrl: "", enterpriseCode: "", enterpriseUser: "", enterprisePassword: "",
  storeId: "", storeName: "", terminalPosId: "", terminalName: "",
  terminalUid: "", token: "", activated: false,
};

export function loadSettings(): Settings {
  const s = { ...DEFAULTS, ...loadJSON<Partial<Settings>>(KEY, {}) };
  if (!s.terminalUid) { s.terminalUid = mintUid(); saveJSON(KEY, s); }
  return s;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => { const next = { ...prev, ...patch }; saveJSON(KEY, next); return next; });
  }, []);
  return { settings, update };
}

/** Aireus convention: enterprise code → host (ENOX → https://enox.aireus.com). */
export const entHost = (code: string) => `https://${code.trim().toLowerCase()}.aireus.com`;
