// Applies the dashboard's edits (config/edits.json, committed by the browser app) to the database.
// Overrides always win over the classifier; manual entries are upserted; removed manual entries are deleted.
import fs from "node:fs";
import { openDb, insertHit, updateHit } from "./db.js";
import { canonicalUrl, domainOf, outletForDomain, guessLanguage } from "./util.js";

const FILE = "config/edits.json";
const OVERRIDABLE = ["relevant", "tier", "sentiment", "type", "summary_en", "summary_fr"];

export function loadEdits() {
  if (!fs.existsSync(FILE)) return { overrides: {}, manual: [] };
  const e = JSON.parse(fs.readFileSync(FILE, "utf8"));
  return { overrides: e.overrides || {}, manual: e.manual || [] };
}

export function manualKey(m) {
  return m.url && /^https?:/i.test(m.url) ? canonicalUrl(m.url) : `manual:${m.id}`;
}

const int = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

/** Returns ids of manual hits that still need a summary (for the classifier). */
export function applyEdits(log = console) {
  const db = openDb();
  const { overrides, manual } = loadEdits();
  const needSummary = [];

  const keep = new Set();
  for (const m of manual) {
    if (!m.project_id || !m.title) continue;
    const key = manualKey(m);
    keep.add(`${m.project_id}|${key}`);
    const domain = domainOf(m.url || "");
    const outlet = outletForDomain(domain);
    const fields = {
      medium: m.medium || "social",
      platform: m.platform || null,
      url: m.url || key,
      title: m.title,
      snippet: m.notes || null,
      author: m.author || null,
      outlet: m.outlet || outlet?.name || domain || m.platform || null,
      outlet_domain: domain || null,
      tier: ["A", "B", "C"].includes(m.tier) ? m.tier : outlet?.tier ?? null,
      published_at: m.published_at ? new Date(m.published_at).toISOString() : new Date().toISOString(),
      lang: m.lang || guessLanguage(`${m.title} ${m.notes || ""}`),
      type: m.type || (m.medium === "social" ? "social" : "news"),
      sentiment: m.sentiment || null,
      views: int(m.views), likes: int(m.likes), comments: int(m.comments), audience: int(m.audience),
    };
    const existing = db.prepare("SELECT id, summary_en, summary_fr, sentiment FROM hits WHERE project_id = ? AND canonical_url = ?").get(m.project_id, key);
    let id;
    if (existing) {
      id = existing.id;
      // keep auto-generated summary/sentiment unless the user provided their own
      updateHit(id, {
        ...fields,
        sentiment: fields.sentiment || existing.sentiment,
        summary_en: m.summary_en || existing.summary_en,
        summary_fr: m.summary_fr || existing.summary_fr,
        source: "manual", relevant: 1, manual_override: 1, raw: JSON.stringify({ manual_id: m.id }),
      });
    } else {
      id = insertHit({
        project_id: m.project_id, source: "manual", canonical_url: key, ...fields,
        summary_en: m.summary_en || null, summary_fr: m.summary_fr || null,
        relevant: 1, relevance_confidence: 1, classified_by: "manual", manual_override: 1, raw: { manual_id: m.id },
      });
    }
    const row = db.prepare("SELECT summary_en, summary_fr, sentiment FROM hits WHERE id = ?").get(id);
    if (!row.summary_en || !row.summary_fr || !row.sentiment) needSummary.push(id);
  }
  // Manual entries deleted in the dashboard
  const removed = db.prepare("SELECT id, project_id, canonical_url FROM hits WHERE source = 'manual'").all().filter((h) => !keep.has(`${h.project_id}|${h.canonical_url}`));
  for (const h of removed) db.prepare("DELETE FROM hits WHERE id = ?").run(h.id);

  let applied = 0;
  for (const [key, o] of Object.entries(overrides)) {
    const sep = key.indexOf("|");
    const hit = db.prepare("SELECT id FROM hits WHERE project_id = ? AND canonical_url = ?").get(key.slice(0, sep), key.slice(sep + 1));
    if (!hit) continue;
    const fields = { manual_override: 1 };
    for (const k of OVERRIDABLE) if (k in o) fields[k] = k === "relevant" ? (o.relevant ? 1 : 0) : o[k];
    if ("relevant" in o) Object.assign(fields, { classified_by: "manual", relevance_reason: "set in dashboard" });
    updateHit(hit.id, fields);
    // a syndicated copy follows its original's relevance
    if ("relevant" in o) db.prepare("UPDATE hits SET relevant = ? WHERE duplicate_of = ? AND manual_override = 0").run(fields.relevant, hit.id);
    applied++;
  }
  if (manual.length || applied || removed.length) log.info(`Dashboard edits: ${manual.length} manual entries, ${applied} overrides, ${removed.length} removed`);
  return needSummary;
}
