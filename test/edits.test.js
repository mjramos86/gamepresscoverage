import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run in a temp copy of the config dir so we don't touch the real edits file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gpc-"));
fs.cpSync("config", path.join(tmp, "config"), { recursive: true });
process.chdir(tmp);
process.env.DB_PATH = ":memory:";
delete process.env.ANTHROPIC_API_KEY;

const { insertHit, queryHits } = await import(new URL("../src/lib/db.js", import.meta.url));
const { applyEdits } = await import(new URL("../src/lib/edits.js", import.meta.url));
const { buildData } = await import(new URL("../src/export.js", import.meta.url));

const writeEdits = (e) => fs.writeFileSync("config/edits.json", JSON.stringify(e));

test("dashboard edits: overrides, manual entries, deletions", () => {
  insertHit({ project_id: "g", source: "rss", url: "https://a.com/x", canonical_url: "https://a.com/x", title: "A", relevant: 1, published_at: new Date().toISOString() });
  insertHit({ project_id: "g", source: "rss", url: "https://b.com/y", canonical_url: "https://b.com/y", title: "B", relevant: 0, classified_by: "claude-opus-5-5", published_at: new Date().toISOString() });
  writeEdits({
    overrides: { "g|https://a.com/x": { relevant: false }, "g|https://b.com/y": { relevant: true, tier: "A", sentiment: "positive" } },
    manual: [
      { id: "m1", project_id: "g", title: "TikTok by @x", url: "https://www.tiktok.com/@x/video/1?utm_source=a", medium: "social", platform: "TikTok", views: "1200" },
      { id: "m2", project_id: "g", title: "Radio segment", medium: "broadcast", summary_en: "s", summary_fr: "s", sentiment: "neutral" },
    ],
  });
  const needSummary = applyEdits({ info() {} });
  const rel = queryHits({ projectId: "g" });
  assert.deepEqual(rel.map((h) => h.title).sort(), ["B", "Radio segment", "TikTok by @x"]);
  const b = rel.find((h) => h.title === "B");
  assert.equal(b.tier, "A");
  assert.equal(b.manual_override, 1);
  const tiktok = rel.find((h) => h.platform === "TikTok");
  assert.equal(tiktok.views, 1200);
  assert.equal(tiktok.canonical_url, "https://tiktok.com/@x/video/1");
  assert.equal(needSummary.length, 1); // m2 already has summaries + sentiment

  const data = buildData();
  assert.equal(data.hits.find((h) => h.title === "TikTok by @x").manual_id, "m1");
  assert.ok(data.hits.some((h) => h.title === "A" && h.relevant === 0), "manual rejections stay visible");

  // re-applying is idempotent; removing an entry deletes it
  applyEdits({ info() {} });
  writeEdits({ overrides: {}, manual: [{ id: "m1", project_id: "g", title: "TikTok by @x (edited)", url: "https://www.tiktok.com/@x/video/1" }] });
  applyEdits({ info() {} });
  const after = queryHits({ projectId: "g" }).filter((h) => h.source === "manual");
  assert.deepEqual(after.map((h) => h.title), ["TikTok by @x (edited)"]);
});
