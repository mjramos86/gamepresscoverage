#!/usr/bin/env node
// Local dashboard server: UI + JSON API (manual entries, overrides, on-demand polling, reports).
import "./lib/env.js";
import "./lib/dbflag.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { openDb, queryHits, queryStreams, insertHit, updateHit, getHit, pollStates } from "./lib/db.js";
import { loadProjects, getProject } from "./lib/config.js";
import { canonicalUrl, domainOf, outletForDomain, guessLanguage } from "./lib/util.js";
import { buildReport } from "./report.js";
import { pollAll } from "./poll.js";
import { hasClaude, classifyWithClaude, MODEL, TYPES, SENTIMENTS } from "./lib/classify.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.DASHBOARD_TOKEN || "";
const WEB = path.resolve("web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const MEDIA = ["web", "video", "stream", "social", "print", "broadcast", "podcast"];
let polling = false;

export function dashboardData({ days = 365 } = {}) {
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const projects = loadProjects({ includeInactive: true }).map(({ id, name, client, branding, active }) => ({ id, name, client, branding, active }));
  return {
    generated_at: new Date().toISOString(),
    projects,
    hits: queryHits({ from, includeIrrelevant: true }).map(({ raw, ...h }) => h),
    streams: queryStreams({ from }),
    poll_state: pollStates(),
    classifier: hasClaude() ? MODEL : "heuristic",
    enums: { types: TYPES, sentiments: SENTIMENTS, media: MEDIA },
  };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error("body too large");
  }
  return data ? JSON.parse(data) : {};
}

const str = (v, max = 2000) => (v == null || v === "" ? null : String(v).slice(0, max));
const int = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

async function createManualHit(body) {
  const project = getProject(body.project_id);
  if (!project) throw Object.assign(new Error("unknown project"), { status: 400 });
  if (!body.title) throw Object.assign(new Error("title is required"), { status: 400 });
  const medium = MEDIA.includes(body.medium) ? body.medium : "social";
  const url = str(body.url) || `manual:${Date.now()}`;
  const domain = domainOf(url);
  const outlet = outletForDomain(domain);
  const hit = {
    project_id: project.id,
    source: "manual",
    medium,
    platform: str(body.platform, 40),
    url,
    canonical_url: url.startsWith("http") ? canonicalUrl(url) : url,
    title: str(body.title, 500),
    snippet: str(body.notes),
    author: str(body.author, 200),
    outlet: str(body.outlet, 200) || outlet?.name || domain || null,
    outlet_domain: domain || null,
    tier: ["A", "B", "C"].includes(body.tier) ? body.tier : outlet?.tier ?? null,
    published_at: body.published_at ? new Date(body.published_at).toISOString() : new Date().toISOString(),
    lang: str(body.lang, 5) || guessLanguage(`${body.title} ${body.notes || ""}`),
    type: TYPES.includes(body.type) ? body.type : medium === "social" ? "social" : "news",
    sentiment: SENTIMENTS.includes(body.sentiment) ? body.sentiment : null,
    relevant: 1,
    relevance_confidence: 1,
    classified_by: "manual",
    manual_override: 1,
    summary_en: str(body.summary_en, 500),
    summary_fr: str(body.summary_fr, 500),
    views: int(body.views),
    likes: int(body.likes),
    comments: int(body.comments),
    audience: int(body.audience),
  };
  const id = insertHit(hit);
  if (!id) throw Object.assign(new Error("this URL is already logged for this project"), { status: 409 });
  // Let Claude write the bilingual summary / sentiment if the user left them blank.
  if (hasClaude() && (!hit.summary_en || !hit.summary_fr || !hit.sentiment)) {
    try {
      const r = await classifyWithClaude(project, { ...hit, id });
      updateHit(id, { summary_en: hit.summary_en || r.summary_en, summary_fr: hit.summary_fr || r.summary_fr, sentiment: hit.sentiment || r.sentiment });
    } catch (err) {
      console.warn(`manual hit #${id}: summary generation failed: ${err.message}`);
    }
  }
  return getHit(id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method !== "GET" && TOKEN && req.headers["x-dashboard-token"] !== TOKEN) return send(res, 401, { error: "missing or invalid dashboard token" });

    if (url.pathname === "/api/data" && req.method === "GET") {
      return send(res, 200, { ...dashboardData({ days: Number(url.searchParams.get("days") || 365) }), mode: "server", polling, token_required: Boolean(TOKEN) });
    }
    if (url.pathname === "/api/hits" && req.method === "POST") {
      return send(res, 201, await createManualHit(await readBody(req)));
    }
    const m = url.pathname.match(/^\/api\/hits\/(\d+)$/);
    if (m && req.method === "PATCH") {
      const id = Number(m[1]);
      if (!getHit(id)) return send(res, 404, { error: "not found" });
      const b = await readBody(req);
      const fields = { manual_override: 1 };
      if ("relevant" in b) Object.assign(fields, { relevant: b.relevant ? 1 : 0, classified_by: "manual", relevance_reason: "set manually" });
      if ("tier" in b) fields.tier = ["A", "B", "C"].includes(b.tier) ? b.tier : null;
      if ("type" in b && TYPES.includes(b.type)) fields.type = b.type;
      if ("sentiment" in b && SENTIMENTS.includes(b.sentiment)) fields.sentiment = b.sentiment;
      for (const k of ["summary_en", "summary_fr", "title", "outlet"]) if (k in b) fields[k] = str(b[k], 500);
      for (const k of ["views", "audience"]) if (k in b) fields[k] = int(b[k]);
      updateHit(id, fields);
      return send(res, 200, getHit(id));
    }
    if (m && req.method === "DELETE") {
      const hit = getHit(Number(m[1]));
      if (!hit) return send(res, 404, { error: "not found" });
      if (hit.source !== "manual") return send(res, 400, { error: "only manual entries can be deleted; mark others as not relevant" });
      openDb().prepare("DELETE FROM hits WHERE id = ?").run(hit.id);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/poll" && req.method === "POST") {
      if (polling) return send(res, 409, { error: "a poll is already running" });
      polling = true;
      const b = await readBody(req);
      pollAll({ force: Boolean(b.force), only: b.project_id || null })
        .catch((err) => console.error("poll failed:", err))
        .finally(() => (polling = false));
      return send(res, 202, { started: true });
    }
    if (url.pathname === "/report" && req.method === "GET") {
      const project = getProject(url.searchParams.get("project") || "");
      if (!project) return send(res, 404, "unknown project", "text/plain");
      const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get("from") || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      return send(res, 200, buildReport(project, { from, to, lang: url.searchParams.get("lang") || undefined }), MIME[".html"]);
    }
    if (req.method === "GET") {
      const file = path.join(WEB, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
      if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
    }
    send(res, 405, { error: "method not allowed" });
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

openDb();
server.listen(PORT, HOST, () => {
  console.log(`Dashboard: http://${HOST}:${PORT}  (classifier: ${hasClaude() ? MODEL : "heuristic"})`);
});
