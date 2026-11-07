// Builds data.json: the collected coverage the dashboard reads (published on the coverage-data branch).
import fs from "node:fs";
import path from "node:path";
import { queryHits, queryStreams, pollStates } from "./lib/db.js";
import { hasClaude, MODEL } from "./lib/classify.js";

export function buildData() {
  const yearAgo = new Date(Date.now() - 400 * 86400_000).toISOString();
  const reviewWindow = Date.now() - 120 * 86400_000;
  const hits = queryHits({ from: yearAgo, includeIrrelevant: true, limit: 20000 })
    // keep confirmed coverage, plus recent AI rejections for the "To review" tab (not the free keyword pre-filter rejects)
    .filter((h) => h.relevant === 1 || (h.relevant === 0 && h.classified_by !== "prefilter" && Date.parse(h.discovered_at) >= reviewWindow))
    .map(({ raw, snippet, ...h }) => {
      if (h.source === "manual") {
        try { h.manual_id = JSON.parse(raw || "{}").manual_id ?? null; } catch { h.manual_id = null; }
      }
      return h;
    });
  return {
    generated_at: new Date().toISOString(),
    classifier: hasClaude() ? MODEL : "keyword heuristic (no Claude key)",
    hits,
    streams: queryStreams({ from: yearAgo }),
    poll_state: pollStates(),
  };
}

export function exportData(out = "data/data.json") {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const data = buildData();
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`Wrote ${out} (${data.hits.length} hits, ${data.streams.length} streams)`);
}
