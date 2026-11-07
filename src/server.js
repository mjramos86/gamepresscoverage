#!/usr/bin/env node
// Local, read-only preview of the dashboard (the real app runs on GitHub Pages).
// Serves the static app plus a live data.json built from the local database.
import "./lib/env.js";
import "./lib/dbflag.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./lib/db.js";
import { buildData } from "./export.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(".");
const ALLOWED = [/^\/index\.html$/, /^\/web\/[\w./-]+$/, /^\/config\/[\w-]+\.json$/];
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body, type = "text/plain") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, "read-only");
    if (url.pathname === "/data.json") return send(200, JSON.stringify(buildData()), MIME[".json"]);
    const p = url.pathname === "/" ? "/index.html" : path.posix.normalize(url.pathname);
    if (!ALLOWED.some((r) => r.test(p))) return send(404, "not found");
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return send(404, "not found");
    send(200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  })
  .listen(PORT, HOST, () => {
    openDb();
    console.log(`Local preview: http://${HOST}:${PORT}`);
  });
