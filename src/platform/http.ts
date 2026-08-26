/*
 * HTTP seam — the ONLY place requests are made.
 *
 * Web build: plain fetch. The pqserver sends no CORS headers, so a web deploy
 * must be same-origin with the queue (serve dist/ from the pqserver's web root,
 * or path-proxy it). Native builds (Capacitor Android/iOS): route through the
 * Capacitor HTTP plugin, which uses the OS network stack — no CORS at all, the
 * panel can reach the queue by LAN IP directly.
 *
 * We detect Capacitor via the injected global rather than importing
 * @capacitor/core, so the web bundle carries zero native code.
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  bytes(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    CapacitorHttp?: {
      request(opts: Record<string, unknown>): Promise<{ status: number; data: unknown }>;
    };
    [k: string]: unknown;
  };
}

export function capacitor(): CapacitorGlobal | null {
  const c = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return c ?? null;
}

export function isNative(): boolean {
  return !!capacitor()?.isNativePlatform?.();
}

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** One request. `body` is sent verbatim; headers are passed through untouched
 *  (the protocol layer owns the Content-Type quirks). */
export async function httpRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  const native = capacitor()?.Plugins?.CapacitorHttp;
  if (isNative() && native) {
    const res = await native.request({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      data: init.body,
      responseType: "arraybuffer", // data arrives base64-encoded
    });
    const b64 = typeof res.data === "string" ? res.data : "";
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      bytes: async () => b64ToBuffer(b64),
      text: async () => new TextDecoder("utf-8").decode(b64ToBuffer(b64)),
    };
  }
  // DEV ONLY: absolute URLs relay through the Vite dev forwarder (vite.config.ts),
  // emulating the native builds' CORS-free OS networking so the app can be used
  // against a real server exactly as in production. Prod web builds skip this —
  // they deploy same-origin on the pqserver.
  const target =
    import.meta.env?.DEV && /^https?:\/\//.test(url)
      ? `/__fwd?url=${encodeURIComponent(url)}`
      : url;
  const res = await fetch(target, { method: init.method ?? "GET", headers: init.headers, body: init.body });
  return {
    ok: res.ok,
    status: res.status,
    bytes: () => res.arrayBuffer(),
    text: () => res.text(),
  };
}
