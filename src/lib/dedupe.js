// Syndication / repost dedup. Exact duplicates are already prevented by UNIQUE(project, canonical_url);
// this merges near-identical titles (wire stories, Google News copies of RSS items, cross-posts)
// published within a few days of each other into one entry (duplicate_of -> the earliest).
import { openDb } from "./db.js";
import { titleTokens, jaccard } from "./util.js";

const WINDOW_DAYS = 5;
const THRESHOLD = 0.72;
const DEDUPABLE = new Set(["web", "print", "broadcast"]);

export function findDuplicate(hit, candidates) {
  const tokens = titleTokens(hit.title);
  if (tokens.size < 3) return null;
  const t = Date.parse(hit.published_at || hit.discovered_at);
  let best = null;
  for (const c of candidates) {
    if (c.id === hit.id || c.duplicate_of) continue;
    const ct = Date.parse(c.published_at || c.discovered_at);
    if (Math.abs(ct - t) > WINDOW_DAYS * 86400_000) continue;
    const sameOutletSameStory = c.outlet_domain && c.outlet_domain === hit.outlet_domain;
    const score = jaccard(tokens, titleTokens(c.title));
    if (score >= THRESHOLD || (sameOutletSameStory && score >= 0.5)) {
      // prefer the earliest-published (or lowest id) as the original
      if (!best || ct < Date.parse(best.published_at || best.discovered_at)) best = c;
    }
  }
  return best;
}

/** Mark new hits as duplicates of older ones. Returns ids marked. */
export function dedupeNewHits(projectId, newIds) {
  if (!newIds.length) return [];
  const db = openDb();
  const since = new Date(Date.now() - 45 * 86400_000).toISOString();
  const pool = db
    .prepare("SELECT id, title, outlet_domain, published_at, discovered_at, duplicate_of, medium FROM hits WHERE project_id = ? AND discovered_at >= ? ORDER BY id")
    .all(projectId, since)
    .filter((h) => DEDUPABLE.has(h.medium));
  const marked = [];
  for (const id of newIds) {
    const hit = pool.find((h) => h.id === id);
    if (!hit) continue;
    const dup = findDuplicate(hit, pool.filter((c) => c.id < id || !newIds.includes(c.id)));
    if (dup) {
      db.prepare("UPDATE hits SET duplicate_of = ? WHERE id = ?").run(dup.id, id);
      hit.duplicate_of = dup.id;
      marked.push(id);
    }
  }
  return marked;
}
