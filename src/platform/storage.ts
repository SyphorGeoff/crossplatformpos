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
