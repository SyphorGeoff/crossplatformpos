/*
 * Device seam — screen wake lock (the iPad disables the idle timer in
 * KDSAppDelegate.m applicationDidFinishLaunching) and platform info.
 */

import { useEffect } from "react";

export function useWakeLock(): void {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock;
        lock = (await wl?.request("screen")) ?? null;
      } catch { /* denied — kiosk/native keeps the screen on anyway */ }
    };
    void request();
    const onVis = () => { if (document.visibilityState === "visible") void request(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => {});
    };
  }, []);
}
