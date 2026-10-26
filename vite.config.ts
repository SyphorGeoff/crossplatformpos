import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
// One version for the web build: package.json "version" (keep it equal to the APK versionName at each release).
const APP_VERSION = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;
import { fileURLToPath } from "node:url";
import net from "node:net";
import react from "@vitejs/plugin-react";

/**
 * Dev-only CORS forwarder (same approach proven on the KDS): in DEV the
 * platform/http seam routes absolute URLs through /__fwd?url=… and this
 * middleware performs the request server-side — emulating the native
 * (Capacitor) builds' OS network stack, so the app is used against a real
 * server (e.g. https://enox.aireus.com) with no proxy config to know about.
 * Production web builds deploy same-origin on the server and never touch this.
 */
function devForwarder(): Plugin {
  return {
    name: "pos-dev-forwarder",
    configureServer(server) {
      server.middlewares.use("/__fwd", (req, res) => {
        const u = new URL(req.url ?? "", "http://x").searchParams.get("url");
        if (!u || !/^https?:\/\//.test(u)) { res.statusCode = 400; res.end("bad url"); return; }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const h of ["content-type"]) {
            const v = req.headers[h];
            if (typeof v === "string") headers[h] = v;
          }
          const method = (req.headers["x-fwd-method"] as string) || req.method || "GET";
          fetch(u, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body })
            .then(async (r) => {
              res.statusCode = r.status;
              res.setHeader("content-type", r.headers.get("content-type") ?? "application/octet-stream");
              res.end(Buffer.from(await r.arrayBuffer()));
            })
            .catch((e) => { res.statusCode = 502; res.end(String(e)); });
        });
      });
    },
  };
}

/**
 * Dev-only raw-TCP print relay: the browser can't open a socket, so in DEV the
 * platform/print seam POSTs the base64 ESC/POS job to /__print?ip=…&port=… and
 * this middleware opens a raw TCP connection to the printer (JetDirect 9100) and
 * writes the bytes — exactly what the native TcpPrint plugin does on device. Lets
 * real LAN printers be driven from the dev browser. Never used in production.
 */
function devPrintRelay(): Plugin {
  return {
    name: "pos-dev-print-relay",
    configureServer(server) {
      server.middlewares.use("/__print", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end("post only"); return; }
        const q = new URL(req.url ?? "", "http://x").searchParams;
        const ip = q.get("ip") ?? "";
        const port = Number(q.get("port")) || 9100;
        if (!ip) { res.statusCode = 400; res.end("no ip"); return; }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const data = Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64"); // body is base64 job bytes
          const sock = new net.Socket();
          let done = false;
          const finish = (code: number, msg: string) => { if (done) return; done = true; sock.destroy(); res.statusCode = code; res.end(msg); };
          sock.setTimeout(5000, () => finish(504, "timeout"));
          sock.on("error", (e) => finish(502, String(e)));
          sock.connect(port, ip, () => {
            sock.write(data, () => sock.end());
          });
          sock.on("close", () => finish(done ? 200 : 200, "ok"));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devForwarder(), devPrintRelay()],
  base: "./",
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
