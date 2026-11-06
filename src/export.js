// Static, read-only export of the dashboard (for GitHub Pages / Cloudflare Pages / any static host).
import fs from "node:fs";
import path from "node:path";
import { loadProjects } from "./lib/config.js";
import { buildReport } from "./report.js";
import { queryHits, queryStreams, pollStates } from "./lib/db.js";
import { hasClaude, MODEL, TYPES, SENTIMENTS } from "./lib/classify.js";

export function exportStatic(outDir = "site") {
  fs.mkdirSync(path.join(outDir, "reports"), { recursive: true });
  for (const f of fs.readdirSync("web")) fs.copyFileSync(path.join("web", f), path.join(outDir, f));
  const from = new Date(Date.now() - 365 * 86400_000).toISOString();
  const projects = loadProjects({ includeInactive: true });
  const data = {
    generated_at: new Date().toISOString(),
    mode: "static",
    projects: projects.map(({ id, name, client, branding, active }) => ({ id, name, client, branding, active })),
    // Only confirmed coverage is published; the review queue stays private.
    hits: queryHits({ from }).map(({ raw, relevance_reason, ...h }) => h),
    streams: queryStreams({ from }),
    poll_state: pollStates(),
    classifier: hasClaude() ? MODEL : "heuristic",
    enums: { types: TYPES, sentiments: SENTIMENTS, media: ["web", "video", "stream", "social", "print", "broadcast", "podcast"] },
  };
  fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data));
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  for (const p of projects) {
    const html = buildReport(p, { from: iso(new Date(today - 30 * 86400_000)), to: iso(today) });
    fs.writeFileSync(path.join(outDir, "reports", `${p.id}-last-30-days.html`), html);
  }
  console.log(`Static dashboard exported to ${outDir}/ (${data.hits.length} hits, ${data.streams.length} streams)`);
}
