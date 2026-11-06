import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DB_PATH = ":memory:";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { canonicalUrl, titleTokens, jaccard, guessLanguage, outletForDomain, matchesTerms } = await import("../src/lib/util.js");
const { parseFeed } = await import("../src/collectors/feedparse.js");
const { findDuplicate } = await import("../src/lib/dedupe.js");
const { heuristicClassify, prefilterReject } = await import("../src/lib/classify.js");
const { normalizeProject } = await import("../src/lib/config.js");
const { processProjectHits } = await import("../src/poll.js");
const { queryHits } = await import("../src/lib/db.js");
const { buildReport, streamMetrics } = await import("../src/report.js");

const project = normalizeProject({ id: "t", name: "Solitaire Tower", keywords: ['"Solitaire Tower"'], exclude_terms: ["tower solitaire classic"] });

test("canonicalUrl strips tracking, www, trailing slash and normalises YouTube", () => {
  assert.equal(canonicalUrl("https://www.Example.com/a/b/?utm_source=x&id=3#top"), "https://example.com/a/b?id=3");
  assert.equal(canonicalUrl("https://m.youtube.com/watch?v=abc&feature=share"), "https://youtube.com/watch?v=abc");
  assert.equal(canonicalUrl("https://youtu.be/abc"), "https://youtube.com/watch?v=abc");
});

test("parseFeed handles Google News RSS with <source>", () => {
  const { items } = parseFeed(fs.readFileSync("test/fixtures/gnews.xml", "utf8"));
  assert.equal(items.length, 3);
  assert.equal(items[0].sourceUrl, "https://www.lapresse.ca");
  assert.equal(items[0].sourceName, "La Presse");
  assert.equal(items[0].published, "2026-11-02T13:00:00.000Z");
});

test("parseFeed handles Atom", () => {
  const { items } = parseFeed(fs.readFileSync("test/fixtures/atom.xml", "utf8"));
  assert.equal(items[0].link, "https://example.com/solitaire-tower-review?utm_source=rss");
  assert.equal(items[0].description, "A great game");
  assert.equal(items[0].author, "Jane");
});

test("syndicated titles (Google News ' - Outlet' suffix) are detected as duplicates", () => {
  const a = { id: 1, title: "Un studio montréalais mise sur Solitaire Tower - La Presse", published_at: "2026-11-02T13:00:00Z", outlet_domain: "lapresse.ca" };
  const b = { id: 2, title: "Un studio montréalais mise sur Solitaire Tower - Le Soleil", published_at: "2026-11-02T16:00:00Z", outlet_domain: "lesoleil.com" };
  const c = { id: 3, title: "Solitaire Tower review: a cozy roguelite", published_at: "2026-11-02T16:00:00Z", outlet_domain: "x.com" };
  assert.ok(jaccard(titleTokens(a.title), titleTokens(b.title)) > 0.9);
  assert.equal(findDuplicate(b, [a, c])?.id, 1);
  assert.equal(findDuplicate(c, [a]), null);
});

test("language guess and outlet tiers", () => {
  assert.equal(guessLanguage("Le nouveau jeu est très bon pour les joueurs"), "fr");
  assert.equal(guessLanguage("The new game is out now for everyone"), "en");
  assert.equal(outletForDomain("techno.lapresse.ca")?.tier, "A");
  assert.ok(matchesTerms("SOLITAIRE-TOWER est là", ["solitaire tower"]));
});

test("prefilter and heuristic classifier", () => {
  assert.match(prefilterReject(project, { title: "Best card games", snippet: "Balatro" }), /not present/);
  assert.equal(prefilterReject(project, { title: "Solitaire Tower is out", snippet: "" }), null);
  const r = heuristicClassify(project, { source: "youtube", title: "Solitaire Tower gameplay", snippet: "" });
  assert.equal(r.relevant, true);
  assert.equal(r.type, "video");
});

test("pipeline: store, dedupe, classify (heuristic), skip duplicates on re-poll", async () => {
  const items = parseFeed(fs.readFileSync("test/fixtures/gnews.xml", "utf8")).items.map((it) => ({
    project_id: "t", source: "google_news", medium: "web", url: it.link, canonical_url: canonicalUrl(it.link),
    title: it.title, snippet: it.description, outlet_domain: new URL(it.sourceUrl).hostname.replace(/^www\./, ""), published_at: it.published,
  }));
  const first = await processProjectHits(project, items, { alert: false });
  assert.equal(first.added, 3);
  assert.equal(first.duplicates, 1);
  const again = await processProjectHits(project, items, { alert: false });
  assert.equal(again.added, 0);
  const relevant = queryHits({ projectId: "t" });
  // AppAdvice item doesn't contain "Solitaire Tower" in that order -> rejected by prefilter
  assert.equal(relevant.length, 2);
  assert.equal(relevant.filter((h) => h.duplicate_of).length, 1);
  const html = buildReport(project, { from: "2026-10-01", to: "2026-11-30" });
  assert.match(html, /Retombées/);
  assert.match(html, /La Presse|lapresse/);
});

test("stream metrics", () => {
  const m = streamMetrics({ started_at: "2026-11-01T10:00:00Z", last_seen_at: "2026-11-01T12:00:00Z", viewer_sum: 1000, samples: 10 });
  assert.equal(m.hours, 2);
  assert.equal(m.avg, 100);
  assert.equal(m.hoursWatched, 200);
});
