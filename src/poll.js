// One polling pass: collect -> store -> dedupe -> classify -> alert.
import { loadProjects, getProject } from "./lib/config.js";
import { applyEdits } from "./lib/edits.js";
import { openDb, insertHit, updateHit, getHit, shouldRun, markRun } from "./lib/db.js";
import { classify, classifyWithClaude, mapLimit, hasClaude, MODEL } from "./lib/classify.js";
import { dedupeNewHits } from "./lib/dedupe.js";
import { alertHits, alertStreams } from "./lib/alerts.js";
import { collectOutletFeeds } from "./collectors/rss.js";
import { collectGoogleNews } from "./collectors/googlenews.js";
import { collectYouTube } from "./collectors/youtube.js";
import { pollTwitch } from "./collectors/twitch.js";
import { collectReddit } from "./collectors/reddit.js";
import { collectBluesky } from "./collectors/bluesky.js";

// Minimum minutes between runs of each source (the cron can fire more often).
const INTERVALS = {
  rss: Number(process.env.RSS_EVERY_MIN || 60),
  google_news: Number(process.env.GNEWS_EVERY_MIN || 120),
  reddit: Number(process.env.REDDIT_EVERY_MIN || 120),
  bluesky: Number(process.env.BLUESKY_EVERY_MIN || 120),
  twitch: Number(process.env.TWITCH_EVERY_MIN || 10),
};

const log = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
};

async function runSource(key, minutes, force, fn) {
  if (!shouldRun(key, minutes, force)) return null;
  try {
    const out = await fn();
    markRun(key, "ok", Array.isArray(out) ? `${out.length} items` : "");
    return out;
  } catch (err) {
    markRun(key, "error", err.message);
    log.warn(`  ${key}: ${err.message}`);
    return null;
  }
}

export async function processProjectHits(project, candidates, { alert = true } = {}) {
  const newIds = [];
  for (const c of candidates) {
    if (!c.url) continue;
    const id = insertHit(c);
    if (id) newIds.push(id);
  }
  if (!newIds.length) return { added: 0, relevant: 0 };

  const dupes = new Set(dedupeNewHits(project.id, newIds));
  const originals = newIds.filter((id) => !dupes.has(id)).map(getHit);
  await mapLimit(originals, Number(process.env.CLASSIFY_CONCURRENCY || 4), async (hit) => {
    const r = await classify(project, hit, log);
    updateHit(hit.id, {
      relevant: r.relevant ? 1 : 0,
      relevance_confidence: r.confidence,
      relevance_reason: r.reason,
      lang: r.language && r.language !== "other" ? r.language : hit.lang,
      type: r.type ?? hit.type,
      sentiment: r.sentiment,
      summary_en: r.summary_en,
      summary_fr: r.summary_fr,
      classified_by: r.classified_by,
    });
  });
  // Duplicates inherit the original's verdict (no extra LLM spend).
  for (const id of dupes) {
    const dup = getHit(id);
    const orig = getHit(dup.duplicate_of);
    updateHit(id, { relevant: orig.relevant, type: orig.type, sentiment: orig.sentiment, summary_en: orig.summary_en, summary_fr: orig.summary_fr, classified_by: "duplicate" });
  }

  const fresh = originals.map((h) => getHit(h.id)).filter((h) => h.relevant === 1);
  if (alert && fresh.length) {
    try {
      const sent = await alertHits(project, fresh, log);
      const now = new Date().toISOString();
      for (const id of sent) updateHit(id, { alerted_at: now });
    } catch (err) {
      log.warn(`  alerts[${project.id}]: ${err.message}`);
    }
  }
  return { added: newIds.length, relevant: fresh.length, duplicates: dupes.size };
}

export async function pollAll({ force = false, only = null, alert = true } = {}) {
  openDb();
  const projects = loadProjects().filter((p) => !only || p.id === only);
  log.info(`Polling ${projects.length} project(s) — classifier: ${hasClaude() ? MODEL : "heuristic (no ANTHROPIC_API_KEY)"}`);

  // 1. Apply corrections and manual entries made in the dashboard; let Claude summarise manual entries.
  const needSummary = applyEdits(log);
  if (needSummary.length && hasClaude()) {
    await mapLimit(needSummary, 3, async (id) => {
      const hit = getHit(id);
      const project = getProject(hit.project_id);
      if (!project) return;
      try {
        const r = await classifyWithClaude(project, hit);
        updateHit(id, { summary_en: hit.summary_en || r.summary_en, summary_fr: hit.summary_fr || r.summary_fr, sentiment: hit.sentiment || r.sentiment });
      } catch (err) {
        log.warn(`  manual entry #${id}: summary failed (${err.message})`);
      }
    });
  }

  const candidates = new Map(projects.map((p) => [p.id, []]));
  const add = (pid, items) => items && candidates.get(pid).push(...items);

  const rssByProject = await runSource("rss", INTERVALS.rss, force, () => collectOutletFeeds(projects, log).then((m) => [...m.values()].flat()));
  if (rssByProject) for (const h of rssByProject) add(h.project_id, [h]);

  for (const p of projects) {
    log.info(`[${p.name}]`);
    // First run for a project backfills ~30 days of results: store them, but don't spam the alert channel.
    const bootstrap = !openDb().prepare("SELECT 1 FROM poll_state WHERE key LIKE ?").get(`%:${p.id}`);
    if (bootstrap && alert) log.info("  first run for this project: backfilling without alerts");
    const s = p.sources;
    if (s.google_news) add(p.id, await runSource(`google_news:${p.id}`, INTERVALS.google_news, force, () => collectGoogleNews(p, log)));
    if (s.youtube?.enabled) add(p.id, await runSource(`youtube:${p.id}`, (s.youtube.every_hours || 6) * 60, force, () => collectYouTube(p, log)));
    if (s.reddit?.enabled) add(p.id, await runSource(`reddit:${p.id}`, INTERVALS.reddit, force, () => collectReddit(p, log)));
    if (s.bluesky?.enabled) add(p.id, await runSource(`bluesky:${p.id}`, INTERVALS.bluesky, force, () => collectBluesky(p, log)));
    if (s.twitch?.enabled) {
      const tw = await runSource(`twitch:${p.id}`, INTERVALS.twitch, force, () => pollTwitch(p, log));
      if (tw?.newStreams?.length && alert && !bootstrap) {
        try {
          await alertStreams(p, tw.newStreams, log);
          const now = new Date().toISOString();
          for (const st of tw.newStreams) openDb().prepare("UPDATE streams SET alerted_at = ? WHERE stream_id = ?").run(now, st.id);
        } catch (err) {
          log.warn(`  alerts[${p.id}]: ${err.message}`);
        }
      }
    }
    const stats = await processProjectHits(p, candidates.get(p.id), { alert: alert && !bootstrap });
    log.info(`  => ${stats.added} new, ${stats.relevant} relevant${stats.duplicates ? `, ${stats.duplicates} merged duplicates` : ""}`);
  }
}
