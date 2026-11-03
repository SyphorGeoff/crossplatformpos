/*
 * Storage seam — quota/lockdown-guarded localStorage. The iPad persists its
 * order lanes and settings in NSUserDefaults; this is the web/native analog.
 * Every read guards shape (a corrupt value must never blank a kitchen screen).
 */

const NS = "apos.";

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw) as T;
    if (Array.isArray(fallback) && !Array.isArray(v)) return fallback;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    /* full / private mode — the app keeps running from memory */
  }
}

export function loadStr(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(NS + key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveStr(key: string, value: string): void {
  try {
    localStorage.setItem(NS + key, value);
  } catch {
    /* ignore */
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(NS + key);
  } catch {
    /* ignore */
  }
}

/** Wipe everything this terminal cached for its store — every definition table,
 *  the revision map, the open check and the lanes — keeping only the settings
 *  record. Called when the terminal is (re)activated: a terminal that moves to
 *  another store or enterprise must start from a full pull, or the incremental
 *  sync keeps every old table whose revision number was higher (2026-11-03: a
 *  web terminal re-activated from enox to live ran with a mix of both). */
export function clearTerminalData(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS) && k !== NS + "settings.v1") keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
