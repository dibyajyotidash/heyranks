// Local dev server: the static site + the full API on http://localhost:8787, with a SQLite file DB.
//   npm run dev                      (uses .data/dev.db; set TURSO_DATABASE_URL to use Turso instead)
// Without RESEND_API_KEY, emails aren't sent: login / reset links are printed in this terminal.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

if (!process.env.TURSO_DATABASE_URL) {
  mkdirSync(".data", { recursive: true });
  process.env.TURSO_DATABASE_URL = "file:.data/dev.db";
}
const { handleApi } = await import("../lib/api.js");
const { d1 } = await import("../lib/db.js");

const ROOT = resolve(".");
const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = /^\/($|assets\/|[\w-]+(\.(html|txt|xml|css|ico|png|jpe?g|svg|webp))?$)/i;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".txt": "text/plain",
  ".xml": "application/xml", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp" };

const readBody = req => new Promise((ok, fail) => {
  const chunks = [];
  req.on("data", c => chunks.push(c)).on("end", () => ok(Buffer.concat(chunks))).on("error", fail);
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const headers = Object.entries(req.headers).filter(([, v]) => typeof v === "string");
      const request = new Request(url, { method: req.method, headers, body });
      const env = { ...process.env, DB: d1(process.env) };
      const response = await handleApi(request, env, { waitUntil: p => p.catch(console.error) }, url.pathname.slice(5));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      console.log(req.method, url.pathname, response.status);
      return;
    }
    if (!PUBLIC.test(url.pathname)) { res.writeHead(404).end("Not found"); return; }
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!extname(path)) path += ".html";
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(data);
  } catch (err) {
    if (err.code === "ENOENT") { res.writeHead(404).end("Not found"); return; }
    console.error(err);
    res.writeHead(500).end("Server error");
  }
}).listen(PORT, () => console.log(`HeyRanks dev server: http://localhost:${PORT}  (DB: ${process.env.TURSO_DATABASE_URL})`));
