/*
 * Standalone dev print relay — a raw-TCP bridge for the browser dev build.
 * The Vite dev server's built-in /__print relay can't reach LAN printers when
 * the dev server runs sandboxed (private-IP egress blocked). Run THIS process
 * unsandboxed on the machine that shares the printers' LAN; the app POSTs its
 * base64 ESC/POS job here and it opens a raw TCP socket to the printer (9100).
 *
 *   node scripts/printrelay.mjs          # listens on 127.0.0.1:8781
 * Then in the app (browser console):
 *   localStorage.setItem('apos.dev.printrelay','http://localhost:8781/print')
 *
 * Not part of the app or any production build — a bench-testing tool only.
 */
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.RELAY_PORT) || 8781;

function sendToPrinter(ip, port, buf) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (ok, msg) => { if (done) return; done = true; sock.destroy(); resolve({ ok, msg }); };
    sock.setTimeout(5000, () => fin(false, "timeout"));
    sock.on("error", (e) => fin(false, String(e)));
    sock.connect(port, ip, () => sock.write(buf, () => sock.end()));
    sock.on("close", () => fin(true, "ok"));
  });
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") { res.statusCode = 405; res.end("post only"); return; }
  const u = new URL(req.url, "http://x");
  const ip = u.searchParams.get("ip");
  const port = Number(u.searchParams.get("port")) || 9100;
  if (!ip) { res.statusCode = 400; res.end("no ip"); return; }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const buf = Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64");
    const r = await sendToPrinter(ip, port, buf);
    console.log(`[printrelay] ${ip}:${port} <- ${buf.length}B => ${r.ok ? "ok" : "FAIL " + r.msg}`);
    res.statusCode = r.ok ? 200 : 502;
    res.end(r.msg);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[printrelay] listening on http://127.0.0.1:${PORT} (POST /print?ip=&port=)`));
