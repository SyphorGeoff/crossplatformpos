import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
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

export default defineConfig({
  plugins: [react(), devForwarder()],
  base: "./",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
} as Parameters<typeof defineConfig>[0]);
