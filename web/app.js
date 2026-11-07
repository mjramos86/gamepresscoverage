// Press Coverage dashboard. Runs as a static site (GitHub Pages). The GitHub repository is the
// backend: settings are JSON files on `main`, collected data lives on the `coverage-data` branch,
// and the collector runs in GitHub Actions. Editing needs a personal access token (kept in this browser).
import { GitHub, GitHubError } from "./github.js";
import { renderReport, selectForReport } from "./report-core.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => (n == null || n === "" ? "—" : nf.format(n));
const when = (h) => h.published_at || h.discovered_at;
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? u : null);
const today = () => new Date().toISOString().slice(0, 10);

function ago(d) {
  if (!d) return "never";
  const s = (Date.now() - Date.parse(d)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString(state.lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", year: "numeric" }) : "";
}
function store(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function recall(key, fallback = null) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

const ICON = { rss: "📰", google_news: "📰", youtube: "▶️", twitch: "🟣", reddit: "💬", bluesky: "🦋", manual: "✍️" };
const MEDIUM_ICON = { web: "📰", video: "▶️", social: "💬", print: "🗞️", broadcast: "📻", podcast: "🎙️", stream: "🟣" };
const TYPES = ["review", "preview", "news", "feature", "interview", "guide", "listicle", "video", "stream", "social", "other"];
const SENTIMENTS = ["positive", "neutral", "negative", "mixed"];
const KIND_FILTERS = {
  "": "All coverage",
  web: "Articles",
  video: "Videos",
  social: "Social media",
  offline: "Print, radio & TV",
};

const SERVICES = [
  { names: ["ANTHROPIC_API_KEY"], label: "Claude (AI filter & summaries)", why: "Checks that each result is really about your game and writes the French/English summaries. Without it, a simpler keyword match is used.", link: "https://console.anthropic.com/settings/keys", linkText: "Get an API key" },
  { names: ["YOUTUBE_API_KEY"], label: "YouTube", why: "Finds new videos about your games, with views and channel sizes. Free.", link: "https://console.cloud.google.com/apis/library/youtube.googleapis.com", linkText: "Enable the YouTube Data API, then create an API key" },
  { names: ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"], label: "Twitch", why: "Logs who streams your game, for how long, and how many viewers. Free.", link: "https://dev.twitch.tv/console/apps/create", linkText: "Register an app (any name, redirect URL http://localhost), then copy its Client ID and a new Client Secret" },
  { names: ["DISCORD_WEBHOOK_URL"], label: "Discord alerts (all games)", why: "Posts new coverage and live streams to a Discord channel. Each game can also have its own channel in its settings.", link: "https://support.discord.com/hc/en-us/articles/228383668", linkText: "How to create a webhook (Channel settings → Integrations → Webhooks)" },
  { names: ["SLACK_WEBHOOK_URL"], label: "Slack alerts (all games)", why: "Same alerts, in Slack.", link: "https://api.slack.com/messaging/webhooks", linkText: "Create an incoming webhook" },
  { names: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], label: "Reddit (optional)", why: "Reddit search mostly works without this, but Reddit sometimes blocks automated searches. A free 'script' app makes it reliable.", link: "https://www.reddit.com/prefs/apps", linkText: "Create a 'script' app" },
  { names: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"], label: "Bluesky (optional)", why: "Bluesky search may require being logged in. Use an app password, not your real password.", link: "https://bsky.app/settings/app-passwords", linkText: "Create an app password" },
];

const MODELS = [
  ["claude-haiku-5-5", "Claude Haiku 5.5 — cheapest (fractions of a cent per result), good for most games"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 — balanced"],
  ["claude-opus-5-5", "Claude Opus 5.5 — most accurate, for tricky generic names"],
];

// ---------------------------------------------------------------- state
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const repoSlug = (() => {
  if (location.hostname.endsWith(".github.io")) {
    const owner = location.hostname.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return { owner, repo };
  }
  const [owner, repo] = ($('meta[name="gpc-repo"]')?.content || "/").split("/");
  return { owner, repo };
})();

const state = {
  gh: null,
  canWrite: false,
  access: {},
  repo: null,
  data: { hits: [], streams: [], poll_state: [], generated_at: null },
  projects: [],
  outlets: [],
  settings: {},
  edits: { overrides: {}, manual: [] },
  ops: [],
  saving: false,
  secrets: null,
  runs: [],
  project: recall("gpc.project", ""),
  days: Number(recall("gpc.days", 30)),
  lang: recall("gpc.lang", "en"),
  view: "coverage",
  filters: { q: "", kind: "", lang: "", tier: "", sent: "", dups: false },
  editingGame: null,
  loaded: false,
};

// ---------------------------------------------------------------- loading
const rawUrl = (ref, path) => `https://raw.githubusercontent.com/${repoSlug.owner}/${repoSlug.repo}/${ref}/${path}?t=${Date.now()}`;

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return res.json();
}

async function readConfig(path) {
  if (state.gh) return (await state.gh.readJson(path))?.json ?? null;
  if (LOCAL) return fetchJson(path);
  return fetchJson(rawUrl("main", path));
}

async function loadConfig() {
  const [projects, outlets, edits, settings] = await Promise.all([
    readConfig("config/projects.json"),
    readConfig("config/outlets.json"),
    readConfig("config/edits.json"),
    readConfig("config/settings.json"),
  ]);
  state.projects = projects?.projects ?? [];
  state.outlets = outlets?.outlets ?? [];
  state.edits = { overrides: edits?.overrides ?? {}, manual: edits?.manual ?? [] };
  for (const op of state.ops) applyOp(state.edits, op); // keep unsaved local changes visible
  state.settings = settings ?? {};
  if (!state.projects.some((p) => p.id === state.project)) state.project = state.projects.find((p) => p.active !== false)?.id || state.projects[0]?.id || "";
}

async function loadData() {
  let data;
  if (state.gh) data = await state.gh.readRawJson("data.json", "coverage-data");
  else if (LOCAL) data = await fetchJson("data.json");
  else data = await fetchJson(rawUrl("coverage-data", "data.json"));
  state.data = data ?? { hits: [], streams: [], poll_state: [], generated_at: null };
}

async function loadAccount() {
  if (!state.gh) return;
  state.access = {};
  try {
    state.repo = await state.gh.repoInfo();
    state.canWrite = state.repo.permissions ? state.repo.permissions.push !== false : true;
  } catch (err) {
    state.canWrite = false;
    state.access.error = err.status === 401 ? "This token is invalid or expired." : err.message;
    return;
  }
  await Promise.all([
    state.gh.secretNames().then((s) => (state.secrets = s), () => { state.secrets = null; state.access.noSecrets = true; }),
    state.gh.latestRuns().then((r) => (state.runs = r), () => { state.runs = []; state.access.noActions = true; }),
  ]);
}

async function connect(token, { quiet = false } = {}) {
  state.gh = new GitHub({ ...repoSlug, token });
  await loadAccount();
  if (state.access.error) {
    const msg = state.access.error;
    state.gh = null;
    if (!quiet) throw new Error(msg);
    return false;
  }
  store("gpc.token", token);
  return true;
}

async function reloadAll() {
  await Promise.all([loadConfig(), loadData()]);
  render();
}

// ---------------------------------------------------------------- edits (corrections + manual entries)
function applyOp(edits, op) {
  edits.overrides ??= {};
  edits.manual ??= [];
  if (op.type === "override") edits.overrides[op.key] = { ...(edits.overrides[op.key] || {}), ...op.fields };
  if (op.type === "addManual") edits.manual = [...edits.manual.filter((m) => m.id !== op.entry.id), op.entry];
  if (op.type === "removeManual") edits.manual = edits.manual.filter((m) => m.id !== op.id);
  return edits;
}

let saveTimer;
function queueOp(op) {
  applyOp(state.edits, op);
  state.ops.push(op);
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushOps, 1500);
}

async function flushOps() {
  const ops = state.ops.splice(0);
  if (!ops.length || !state.gh) return;
  state.saving = true;
  renderStatus();
  try {
    const saved = await state.gh.updateJson("config/edits.json", (j) => ops.reduce(applyOp, j), `Dashboard: ${ops.length} change${ops.length > 1 ? "s" : ""}`, { overrides: {}, manual: [] });
    state.edits = { overrides: saved.overrides ?? {}, manual: saved.manual ?? [] };
    for (const op of state.ops) applyOp(state.edits, op);
    toast("Saved ✓ The published data will reflect it after the next update (a few minutes).");
    setTimeout(refreshRuns, 4000);
  } catch (err) {
    state.ops.unshift(...ops);
    toast(`Couldn't save: ${friendlyError(err)}`, true);
  } finally {
    state.saving = false;
    renderStatus();
  }
}

window.addEventListener("beforeunload", (e) => {
  if (state.ops.length || state.saving) e.preventDefault();
});

const hitKey = (h) => `${h.project_id}|${h.canonical_url}`;

function manualToHit(m, base = {}) {
  return {
    ...base,
    id: base.id ?? `m:${m.id}`,
    manual_id: m.id,
    project_id: m.project_id,
    source: "manual",
    medium: m.medium || "social",
    platform: m.platform || null,
    url: m.url || "",
    title: m.title,
    outlet: m.outlet || base.outlet || m.platform || "",
    author: m.author || null,
    tier: m.tier || base.tier || null,
    published_at: m.published_at ? new Date(m.published_at).toISOString() : base.published_at || new Date().toISOString(),
    discovered_at: base.discovered_at || new Date().toISOString(),
    lang: m.lang || base.lang || null,
    type: m.type || base.type || "social",
    sentiment: m.sentiment || base.sentiment || null,
    summary_en: m.summary_en || base.summary_en || null,
    summary_fr: m.summary_fr || base.summary_fr || null,
    views: num(m.views) ?? base.views ?? null,
    likes: num(m.likes) ?? base.likes ?? null,
    comments: num(m.comments) ?? base.comments ?? null,
    audience: num(m.audience) ?? base.audience ?? null,
    relevant: 1,
    manual_override: 1,
    pending: !base.id,
  };
}
const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Published data with the user's (possibly not yet processed) edits layered on top. */
function allHits() {
  const { overrides, manual } = state.edits;
  const byId = new Map(manual.map((m) => [m.id, m]));
  const seen = new Set();
  const out = [];
  for (const h of state.data.hits) {
    if (h.source === "manual") {
      const m = h.manual_id && byId.get(h.manual_id);
      if (!m) continue; // deleted in the dashboard
      seen.add(m.id);
      out.push(manualToHit(m, h));
      continue;
    }
    const o = overrides[hitKey(h)];
    out.push(o ? { ...h, ...o, relevant: "relevant" in o ? (o.relevant ? 1 : 0) : h.relevant, manual_override: 1 } : h);
  }
  for (const m of manual) if (!seen.has(m.id)) out.push(manualToHit(m));
  // syndicated copies follow their original
  const byHitId = new Map(out.map((h) => [h.id, h]));
  for (const h of out) if (h.duplicate_of && byHitId.get(h.duplicate_of)?.manual_override && !h.manual_override) h.relevant = byHitId.get(h.duplicate_of).relevant;
  return out;
}

const inPeriod = (d) => Date.parse(d) >= Date.now() - state.days * 86400_000;
const projectHits = () => allHits().filter((h) => h.project_id === state.project && inPeriod(when(h)));
const projectStreams = () => state.data.streams.filter((s) => s.project_id === state.project && inPeriod(s.started_at));
const currentProject = () => state.projects.find((p) => p.id === state.project);

function streamMetrics(s) {
  const end = Date.parse(s.ended_at || s.last_seen_at || s.started_at);
  const hours = Math.max(0, (end - Date.parse(s.started_at)) / 3_600_000);
  const avg = s.samples ? s.viewer_sum / s.samples : 0;
  return { hours, avg, hoursWatched: hours * avg };
}

// ---------------------------------------------------------------- GitHub Actions status
const activeRun = () => state.runs.find((r) => r.status !== "completed");
const lastFinishedRun = () => state.runs.find((r) => r.status === "completed");
let runTimer;

async function refreshRuns() {
  if (!state.gh || state.access.noActions) return;
  const wasActive = Boolean(activeRun());
  try {
    state.runs = await state.gh.latestRuns();
  } catch {
    return;
  }
  const nowActive = Boolean(activeRun());
  if (wasActive && !nowActive) {
    await loadData();
    safeRender();
    const last = lastFinishedRun();
    toast(last?.conclusion === "success" ? "Coverage updated ✓" : "The update finished with a problem — see the status bar.", last?.conclusion !== "success");
  } else renderStatus();
  clearTimeout(runTimer);
  runTimer = setTimeout(refreshRuns, nowActive ? 8000 : 60000);
}

async function checkNow() {
  if (!state.gh) return goSettings();
  if (state.ops.length) await flushOps();
  const btn = $("#checkBtn");
  btn.disabled = true;
  try {
    await state.gh.dispatchPoll({ force: true });
    toast("Checking every source now. This usually takes 1–3 minutes; the page will update by itself.");
    setTimeout(refreshRuns, 3000);
  } catch (err) {
    toast(`Couldn't start the check: ${friendlyError(err)}`, true);
  } finally {
    setTimeout(() => (btn.disabled = false), 5000);
  }
}

function friendlyError(err) {
  if (err instanceof GitHubError) {
    if (err.status === 401) return "your GitHub token is invalid or expired. Reconnect in Settings.";
    if (err.status === 403 || err.status === 404) return "your GitHub token doesn't have permission for this. Check its permissions in Settings.";
  }
  return err.message;
}

// ---------------------------------------------------------------- UI helpers
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = "toast"), isError ? 9000 : 5000);
}

function goSettings(section = "connect") {
  location.hash = "settings";
  setTimeout(() => document.getElementById(`set-${section}`)?.scrollIntoView({ behavior: "smooth" }), 50);
}

function renderStatus() {
  const bits = [];
  const run = activeRun();
  const last = lastFinishedRun();
  if (LOCAL) bits.push(`<span>🖥️ Local preview (read-only).</span>`);
  else if (!state.gh) bits.push(`<span>👀 View-only.</span> <button class="link" data-act="connect">Connect your GitHub account</button> <span class="muted">to add games, fix results and check for coverage on demand.</span>`);
  if (run) bits.push(`<span class="busy">⏳ Checking for new coverage… (started ${esc(ago(run.run_started_at || run.created_at))})</span>`);
  else if (state.data.generated_at) bits.push(`<span>Updated ${esc(ago(state.data.generated_at))} · checks automatically every 30 min</span>`);
  else if (state.projects.length) bits.push(`<span class="muted">No coverage collected yet.</span>`);
  if (!run && last && last.conclusion && last.conclusion !== "success" && last.conclusion !== "cancelled")
    bits.push(`<span class="warn">⚠ The last update failed. <a href="${esc(last.html_url)}" target="_blank" rel="noopener">See what happened</a></span>`);
  if (state.saving) bits.push(`<span class="busy">Saving…</span>`);
  else if (state.ops.length) bits.push(`<span class="muted">Unsaved changes…</span>`);
  $("#statusbar").innerHTML = bits.join(`<span class="sep">·</span>`);
}

// ---------------------------------------------------------------- views
/** Re-render for background updates without wiping forms the user may be typing in. */
function safeRender() {
  if (state.view === "settings" || state.view === "add") renderStatus();
  else render();
}

function render() {
  document.body.classList.toggle("can-write", Boolean(state.gh && state.canWrite));
  const p = currentProject();
  document.documentElement.style.setProperty("--accent", p?.branding?.primary_color || "#5b3fd1");
  const sel = $("#project");
  sel.innerHTML = state.projects.length
    ? state.projects.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.client ? ` — ${esc(x.client)}` : ""}${x.active === false ? " (paused)" : ""}</option>`).join("")
    : `<option value="">No games yet</option>`;
  sel.value = state.project;
  $$("#range button").forEach((b) => b.classList.toggle("on", Number(b.dataset.days) === state.days));
  $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.view === state.view));
  const reviewN = reviewItems().length;
  $("#reviewCount").textContent = reviewN || "";
  renderStatus();
  const view = { coverage: viewCoverage, streams: viewStreams, review: viewReview, add: viewAdd, settings: viewSettings }[state.view] || viewCoverage;
  $("#view").innerHTML = view();
  if (state.view === "coverage") renderList();
  if (state.view === "settings" && state.editingGame) $("#gameForm")?.querySelector("input")?.focus({ preventScroll: true });
}

function onboarding() {
  const steps = [
    { done: Boolean(state.gh), text: "Connect your GitHub account", act: "connect" },
    { done: Boolean(state.secrets && ["ANTHROPIC_API_KEY", "YOUTUBE_API_KEY", "TWITCH_CLIENT_ID"].some((k) => state.secrets.has(k))), text: "Add your service keys (Claude, YouTube, Twitch, Discord)", act: "keys" },
    { done: state.projects.length > 0, text: "Add your first game", act: "games" },
    { done: Boolean(state.data.generated_at), text: "Check for coverage", act: "check" },
  ];
  if (LOCAL || steps.every((s) => s.done)) return "";
  return `<section class="panel onboarding">
    <h2>Welcome! Let's get your coverage tracker running</h2>
    <p class="muted">Everything happens here in the browser. Once set up, it checks every source automatically every 30 minutes, even when this page is closed.</p>
    <ol class="steps">${steps
      .map((s, i) => `<li class="${s.done ? "done" : ""}"><span class="num">${s.done ? "✓" : i + 1}</span><span>${esc(s.text)}</span>${s.done ? "" : `<button class="btn small" data-act="step-${s.act}">${i === 3 ? "Check now" : "Go"}</button>`}</li>`)
      .join("")}</ol>
  </section>`;
}

function kpis() {
  const hits = projectHits().filter((h) => h.relevant === 1);
  const orig = hits.filter((h) => !h.duplicate_of);
  const streams = projectStreams();
  const sm = streams.map(streamMetrics);
  const withSent = orig.filter((h) => h.sentiment);
  const tiles = [
    ["Pieces of coverage", orig.length + streams.length, "Articles, videos, posts, streams and manual entries (reprints counted once)"],
    ["Top-tier outlets (A)", orig.filter((h) => h.tier === "A").length, "Major national or games media"],
    ["YouTube views", orig.filter((h) => h.medium === "video").reduce((s, h) => s + (h.views || 0), 0), ""],
    ["Twitch hours watched", Math.round(sm.reduce((s, m) => s + m.hoursWatched, 0)), `${streams.length} streams · peak ${fmt(streams.reduce((m, s) => Math.max(m, s.peak_viewers || 0), 0))} viewers`],
    ["Positive", withSent.length ? `${Math.round((withSent.filter((h) => h.sentiment === "positive").length / withSent.length) * 100)}%` : "—", "Share of coverage that is positive about the game"],
    ["In French", orig.length ? `${Math.round((orig.filter((h) => h.lang === "fr").length / orig.length) * 100)}%` : "—", ""],
  ];
  return `<section class="kpis">${tiles.map(([l, v, t]) => `<div class="kpi" title="${esc(t)}"><b>${typeof v === "number" ? fmt(v) : esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</section>`;
}

function chart() {
  const days = Math.min(state.days, 90);
  const hits = projectHits().filter((h) => h.relevant === 1 && !h.duplicate_of);
  const buckets = new Map();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) buckets.set(new Date(start - i * 86400_000).toISOString().slice(0, 10), 0);
  for (const h of hits) {
    const k = new Date(when(h)).toISOString().slice(0, 10);
    if (buckets.has(k)) buckets.set(k, buckets.get(k) + 1);
  }
  const entries = [...buckets];
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const W = 1000, H = 120, bw = W / entries.length;
  const bars = entries
    .map(([d, v], i) => {
      const h = v ? Math.max(3, (v / max) * (H - 24)) : 0;
      return `<rect class="bar" x="${i * bw + 1}" y="${H - 16 - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${d}: ${v}</title></rect>`;
    })
    .join("");
  const step = Math.ceil(entries.length / 6);
  const labels = entries.map(([d], i) => (i % step === 0 ? `<span style="left:${(i / entries.length) * 100}%">${esc(fmtDate(d + "T12:00:00").replace(/, \d{4}$/, ""))}</span>` : "")).join("");
  return `<section class="panel"><div class="panel-head"><h2>Coverage per day</h2><span class="muted small">most: ${max} in a day</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" role="img" aria-label="Coverage per day"><line class="base" x1="0" x2="${W}" y1="${H - 16}" y2="${H - 16}"/>${bars}</svg>
    <div class="xlabels">${labels}</div></section>`;
}

function viewCoverage() {
  if (!state.projects.length) return onboarding() || `<div class="empty">No games yet. <button class="link" data-act="step-games">Add your first game</button>.</div>`;
  const f = state.filters;
  const opt = (pairs, v) => Object.entries(pairs).map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  return `${onboarding()}${kpis()}${chart()}
  <section class="filters">
    <input id="f-q" type="search" placeholder="Search headlines, outlets, creators…" value="${esc(f.q)}" aria-label="Search">
    <select id="f-kind" aria-label="Kind">${opt(KIND_FILTERS, f.kind)}</select>
    <select id="f-lang" aria-label="Language">${opt({ "": "Any language", fr: "French", en: "English" }, f.lang)}</select>
    <select id="f-tier" aria-label="Outlet tier">${opt({ "": "Any outlet tier", A: "Tier A", B: "Tier B", C: "Tier C" }, f.tier)}</select>
    <select id="f-sent" aria-label="Sentiment">${opt({ "": "Any tone", positive: "Positive", neutral: "Neutral", mixed: "Mixed", negative: "Negative" }, f.sent)}</select>
    <div class="seg" id="langSeg" role="group" aria-label="Summary language"><button data-lang="en" class="${state.lang === "en" ? "on" : ""}">EN</button><button data-lang="fr" class="${state.lang === "fr" ? "on" : ""}">FR</button></div>
  </section>
  <div id="list" class="list"></div>`;
}

function hitCard(h, { review = false, dupCount = 0 } = {}) {
  const url = safeUrl(h.url);
  const summary = (state.lang === "fr" ? h.summary_fr || h.summary_en : h.summary_en || h.summary_fr) || "";
  const icon = ICON[h.source] === "✍️" ? MEDIUM_ICON[h.medium] || "✍️" : ICON[h.source] || "•";
  const meta = [
    `<span class="outlet">${esc(h.outlet || h.platform || h.source)}</span>`,
    h.tier ? `<span class="tag tier t${esc(h.tier)}" title="Outlet tier">${esc(h.tier)}</span>` : "",
    `<span>${esc(fmtDate(when(h)))}</span>`,
    h.lang ? `<span class="tag">${esc(h.lang.toUpperCase())}</span>` : "",
    h.type ? `<span class="tag">${esc(h.type)}</span>` : "",
    h.sentiment ? `<span class="sent ${esc(h.sentiment)}">${esc(h.sentiment)}</span>` : "",
    h.pending ? `<span class="tag pending" title="Saved; it will be processed at the next update">pending</span>` : "",
  ].join("");
  const stats = [
    h.author && h.author !== h.outlet ? `by ${esc(h.author)}` : "",
    h.views ? `${fmt(h.views)} views` : "",
    h.likes ? `${fmt(h.likes)} likes` : "",
    h.comments ? `${fmt(h.comments)} comments` : "",
    h.audience ? `${fmt(h.audience)} ${h.medium === "video" ? "subscribers" : "audience"}` : "",
    dupCount ? `<button class="link small" data-act="dups" data-id="${esc(h.id)}">+${dupCount} reprint${dupCount > 1 ? "s" : ""}</button>` : "",
  ].filter(Boolean);
  const key = h.source === "manual" ? "" : hitKey(h);
  const write = state.gh && state.canWrite;
  let actions = "";
  if (write && review) {
    actions = `<div class="actions"><button class="btn small good" data-act="keep" data-key="${esc(key)}">✓ Yes, it's about the game</button><button class="btn small" data-act="reject" data-key="${esc(key)}">✗ No</button></div>`;
  } else if (write && h.source === "manual") {
    actions = `<div class="actions"><button class="btn small" data-act="delmanual" data-mid="${esc(h.manual_id)}">Delete</button></div>`;
  } else if (write) {
    actions = `<div class="actions">
      <select class="small" data-act="tier" data-key="${esc(key)}" aria-label="Outlet tier"><option value="">Tier –</option>${["A", "B", "C"].map((t) => `<option ${h.tier === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      <select class="small" data-act="sent" data-key="${esc(key)}" aria-label="Tone">${SENTIMENTS.map((s) => `<option ${h.sentiment === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <button class="btn small ghost" data-act="reject" data-key="${esc(key)}" title="Remove from coverage (not about the game)">✗ Not relevant</button></div>`;
  }
  const thumb = h.thumbnail && safeUrl(h.thumbnail) ? `style="background-image:url('${esc(h.thumbnail)}')"` : "";
  return `<article class="hit ${h.duplicate_of ? "dup" : ""} ${h.relevant === 0 ? "rejected" : ""}">
    <div class="thumb" ${thumb}>${thumb ? "" : icon}</div>
    <div class="body">
      <div class="meta">${meta}</div>
      ${url ? `<a class="title" href="${esc(url)}" target="_blank" rel="noopener">${esc(h.title || url)}</a>` : `<span class="title">${esc(h.title)}</span>`}
      ${summary && summary !== h.title ? `<p class="summary">${esc(summary)}</p>` : ""}
      ${review && h.relevance_reason ? `<p class="reason">AI says: ${esc(h.relevance_reason)}${h.relevance_confidence != null ? ` (${Math.round(h.relevance_confidence * 100)}% sure)` : ""}</p>` : ""}
      ${stats.length ? `<div class="stats">${stats.map((s) => `<span>${s}</span>`).join("")}</div>` : ""}
    </div>${actions}</article>`;
}

const expandedDups = new Set();
function renderList() {
  const list = $("#list");
  if (!list) return;
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let hits = projectHits().filter((h) => h.relevant === 1);
  hits = hits.filter(
    (h) =>
      (!q || `${h.title} ${h.outlet} ${h.author} ${h.summary_en} ${h.summary_fr}`.toLowerCase().includes(q)) &&
      (!f.kind || (f.kind === "offline" ? ["print", "broadcast", "podcast"].includes(h.medium) : h.medium === f.kind)) &&
      (!f.lang || h.lang === f.lang) &&
      (!f.tier || h.tier === f.tier) &&
      (!f.sent || h.sentiment === f.sent),
  );
  hits.sort((a, b) => Date.parse(when(b)) - Date.parse(when(a)));
  const dups = new Map();
  for (const h of hits.filter((x) => x.duplicate_of)) dups.set(h.duplicate_of, [...(dups.get(h.duplicate_of) || []), h]);
  const originals = hits.filter((h) => !h.duplicate_of);
  if (!originals.length) {
    list.innerHTML = state.data.generated_at || state.edits.manual.length
      ? `<div class="empty">No coverage for this game and period${q || f.kind || f.lang || f.tier || f.sent ? " with these filters" : " yet"}.</div>`
      : `<div class="empty">Nothing collected yet. The first automatic check runs within 30 minutes of adding a game${state.gh ? `, or <button class="link" data-act="step-check">check now</button>` : ""}.</div>`;
    return;
  }
  list.innerHTML = originals
    .map((h) => hitCard(h, { dupCount: dups.get(h.id)?.length || 0 }) + (expandedDups.has(String(h.id)) ? (dups.get(h.id) || []).map((d) => hitCard(d)).join("") : ""))
    .join("");
}

function reviewItems() {
  return allHits()
    .filter((h) => h.project_id === state.project && inPeriod(when(h)) && !h.manual_override && !h.duplicate_of && h.source !== "manual")
    .filter((h) => (h.relevant === 0 && h.classified_by !== "prefilter") || (h.relevant === 1 && (h.relevance_confidence ?? 1) < 0.7))
    .sort((a, b) => Date.parse(when(b)) - Date.parse(when(a)));
}

function viewReview() {
  const items = reviewItems();
  return `<p class="intro">These are results the AI <b>rejected</b> or <b>wasn't sure about</b>. Have a quick look: confirm the ones that are really about your game. Your answer is final and won't be changed by later checks.</p>
  <div class="list">${items.length ? items.slice(0, 200).map((h) => hitCard(h, { review: true })).join("") : `<div class="empty">Nothing to review 🎉</div>`}</div>`;
}

function viewStreams() {
  const streams = projectStreams();
  if (!streams.length)
    return `<div class="empty">No Twitch streams of this game in this period.<br><span class="muted small">Streams are only found if your game has a category on Twitch and Twitch is set up in Settings.</span></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Streamer</th><th>Stream title</th><th class="r">Followers</th><th class="r">Duration</th><th class="r">Avg viewers</th><th class="r">Peak</th><th class="r">Hours watched</th></tr></thead><tbody>${streams
    .map((s) => {
      const m = streamMetrics(s);
      return `<tr><td>${esc(fmtDate(s.started_at))} ${s.ended_at ? "" : '<span class="live">● LIVE</span>'}</td>
      <td><a href="https://twitch.tv/${esc(encodeURIComponent(s.user_login || ""))}" target="_blank" rel="noopener">${esc(s.user_name)}</a> <span class="tag">${esc((s.language || "").toUpperCase())}</span></td>
      <td>${esc(s.title)}</td><td class="r">${fmt(s.followers)}</td><td class="r">${m.hours.toFixed(1)} h</td>
      <td class="r">${fmt(Math.round(m.avg))}</td><td class="r">${fmt(s.peak_viewers)}</td><td class="r">${fmt(Math.round(m.hoursWatched))}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

function viewAdd() {
  if (!state.gh) return `<div class="empty">Connect your GitHub account to log coverage by hand. <button class="link" data-act="connect">Connect</button></div>`;
  const recent = state.edits.manual.filter((m) => m.project_id === state.project).slice(-8).reverse();
  return `<form id="manualForm" class="panel form">
    <h2>Add coverage by hand</h2>
    <p class="muted">For anything that can't be found automatically: TikTok, Instagram, X, print, radio/TV, podcasts, newsletters… Leave the summaries empty and the AI will write them in French and English.</p>
    <div class="grid">
      <label>What kind?<select name="medium">
        <option value="social">Social media post</option><option value="video">Video</option><option value="print">Print (newspaper, magazine)</option>
        <option value="broadcast">Radio / TV</option><option value="podcast">Podcast</option><option value="web">Web article</option></select></label>
      <label>Platform<input name="platform" list="platforms" placeholder="TikTok, Instagram, X…"></label>
      <datalist id="platforms"><option value="TikTok"><option value="Instagram"><option value="X"><option value="Facebook"><option value="Threads"><option value="LinkedIn"><option value="Newsletter"></datalist>
      <label class="wide">Headline or caption *<input name="title" required></label>
      <label class="wide">Link<input name="url" type="url" placeholder="https://…"></label>
      <label>Outlet or account<input name="outlet" placeholder="La Presse, @creator…"></label>
      <label>Journalist / creator<input name="author"></label>
      <label>Date<input name="published_at" type="date" value="${today()}"></label>
      <label>Outlet tier<select name="tier"><option value="">—</option><option value="A">A — major</option><option value="B">B — specialist/regional</option><option value="C">C — small</option></select></label>
      <label>Language<select name="lang"><option value="">Detect</option><option value="fr">French</option><option value="en">English</option></select></label>
      <label>Tone<select name="sentiment"><option value="">Let the AI decide</option>${SENTIMENTS.map((s) => `<option>${s}</option>`).join("")}</select></label>
      <label>Views<input name="views" type="number" min="0"></label>
      <label>Likes<input name="likes" type="number" min="0"></label>
      <label>Comments<input name="comments" type="number" min="0"></label>
      <label>Audience (followers, circulation)<input name="audience" type="number" min="0"></label>
      <label class="wide">Summary in English (optional)<input name="summary_en"></label>
      <label class="wide">Résumé en français (optionnel)<input name="summary_fr"></label>
    </div>
    <div class="row"><button class="btn primary" type="submit">Add to ${esc(currentProject()?.name || "coverage")}</button></div>
  </form>
  ${recent.length ? `<section class="panel"><h2>Recently added by hand</h2><div class="list">${recent.map((m) => hitCard(manualToHit(m, state.data.hits.find((h) => h.manual_id === m.id) || {}))).join("")}</div></section>` : ""}`;
}

// ---------------------------------------------------------------- settings
function viewSettings() {
  return `<div class="settings">
    ${sectionConnect()}
    ${state.gh ? sectionGames() + sectionKeys() + sectionAi() + sectionOutlets() + sectionAdvanced() : sectionGames()}
  </div>`;
}

function sectionConnect() {
  if (LOCAL) return `<section class="panel" id="set-connect"><h2>Local preview</h2><p class="muted">This copy runs on your computer and is read-only. Use the online version to make changes.</p></section>`;
  if (state.gh) {
    const warn = [];
    if (state.access.noSecrets) warn.push("Your token can't manage <b>Secrets</b>, so you can't save service keys. Create a new token with “Secrets: Read and write”.");
    if (state.access.noActions) warn.push("Your token can't use <b>Actions</b>, so “Check for new coverage” won't work. Create a new token with “Actions: Read and write”.");
    if (state.repo && state.repo.default_branch !== "main")
      warn.push(`Your repository's default branch is <b>${esc(state.repo.default_branch)}</b>. Please switch it to <b>main</b> (<a href="https://github.com/${esc(repoSlug.owner)}/${esc(repoSlug.repo)}/settings" target="_blank" rel="noopener">repository settings</a> → Default branch) so that automatic checks always use your latest settings.`);
    return `<section class="panel" id="set-connect"><h2>GitHub connection</h2>
      <p>✅ Connected to <b>${esc(repoSlug.owner)}/${esc(repoSlug.repo)}</b>. Your token is saved in this browser only.</p>
      ${warn.map((w) => `<p class="warnbox">⚠ ${w}</p>`).join("")}
      <button class="btn" data-act="disconnect">Disconnect this browser</button></section>`;
  }
  const params = new URLSearchParams({
    name: "Press Coverage dashboard",
    description: `Lets the Press Coverage dashboard edit ${repoSlug.owner}/${repoSlug.repo}`,
    target_name: repoSlug.owner,
    expires_in: "366",
    contents: "write",
    actions: "write",
    secrets: "write",
  });
  return `<section class="panel" id="set-connect"><h2>Connect your GitHub account</h2>
    <p>Your settings and coverage are stored in your GitHub repository. To make changes from this page, give it a <b>token</b> (a kind of password limited to this one repository). You only do this once per computer.</p>
    <ol class="howto">
      <li><a class="btn small" href="https://github.com/settings/personal-access-tokens/new?${esc(params.toString())}" target="_blank" rel="noopener">Open GitHub's token page ↗</a></li>
      <li>Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <b>${esc(repoSlug.repo)}</b>.</li>
      <li>Under <b>Permissions → Repository permissions</b>, set <b>Actions</b>, <b>Contents</b> and <b>Secrets</b> to <b>Read and write</b> (they may already be filled in).</li>
      <li>Click <b>Generate token</b>, copy it, and paste it below.</li>
    </ol>
    <form id="connectForm" class="row">
      <input name="token" type="password" placeholder="github_pat_…" autocomplete="off" required aria-label="GitHub token" class="grow">
      <button class="btn primary" type="submit">Connect</button>
    </form>
    <p class="muted small">The token is stored only in this browser and sent only to GitHub. Anyone can <i>view</i> this dashboard; only people with a token can change it.</p>
  </section>`;
}

function gameFormHtml(p) {
  const isNew = !p.id;
  const s = p.sources || {};
  const kw = (p.keywords || [p.name ? p.name : ""]).map((k) => k.replace(/"/g, "")).join("\n");
  const b = p.branding || {};
  const on = (v) => (v ? "checked" : "");
  const tw = s.twitch || {};
  const yt = s.youtube || {};
  const webhookSet = p.alerts?.discord_webhook_env && state.secrets?.has(p.alerts.discord_webhook_env);
  return `<form id="gameForm" class="form gameform" data-id="${esc(p.id || "")}">
    <h3>${isNew ? "Add a game" : `Edit ${esc(p.name)}`}</h3>
    <div class="grid">
      <label>Game name *<input name="name" required value="${esc(p.name || "")}"></label>
      <label>Client / studio<input name="client" value="${esc(p.client || "")}"></label>
      <label class="wide">Short description <span class="hint">Helps the AI tell your game apart from look-alikes: genre, platforms, studio city…</span>
        <textarea name="context" rows="2">${esc(p.context || "")}</textarea></label>
      <label>Search for… <span class="hint">One per line. Usually just the game's name.</span><textarea name="keywords" rows="3">${esc(kw)}</textarea></label>
      <label>Not to be confused with… <span class="hint">One per line (optional)</span><textarea name="exclude" rows="3">${esc((p.exclude_terms || []).join("\n"))}</textarea></label>
    </div>
    <fieldset><legend>Where to look</legend>
      <label class="check"><input type="checkbox" name="web" ${on(s.rss !== false || s.google_news !== false)}> News sites &amp; Google News</label>
      <label class="check"><input type="checkbox" name="youtube" ${on(yt.enabled ?? true)}> YouTube, every <select name="yt_hours">${[3, 6, 12, 24].map((h) => `<option ${Number(yt.every_hours || 6) === h ? "selected" : ""}>${h}</option>`).join("")}</select> hours</label>
      <label class="check"><input type="checkbox" name="twitch" ${on(tw.enabled ?? true)}> Twitch streams, category: <input name="twitch_name" value="${esc(tw.game_name || p.name || "")}" placeholder="Twitch category name"></label>
      <label class="check"><input type="checkbox" name="reddit" ${on(s.reddit?.enabled ?? true)}> Reddit</label>
      <label class="check"><input type="checkbox" name="bluesky" ${on(s.bluesky?.enabled ?? true)}> Bluesky</label>
      <label class="check"><input type="checkbox" name="fr" ${on((p.languages || ["fr", "en"]).includes("fr"))}> French news</label>
      <label class="check"><input type="checkbox" name="en" ${on((p.languages || ["fr", "en"]).includes("en"))}> English news</label>
    </fieldset>
    <fieldset><legend>Alerts</legend>
      <label class="wide">Discord channel for this game <span class="hint">${webhookSet ? "✅ A channel is set. Paste a new webhook URL to replace it." : "Optional. Paste a Discord webhook URL; otherwise the general alert channel (if any) is used."}</span>
        <input name="webhook" type="password" autocomplete="off" placeholder="https://discord.com/api/webhooks/…"></label>
      <label class="check"><input type="checkbox" name="notify_streams" ${on(p.alerts?.notify_streams ?? true)}> Alert when someone goes live on Twitch</label>
    </fieldset>
    <fieldset><legend>Report branding</legend>
      <div class="grid">
        <label>Main colour<input type="color" name="primary_color" value="${esc(b.primary_color || "#5b3fd1")}"></label>
        <label>Accent colour<input type="color" name="accent_color" value="${esc(b.accent_color || "#f2b705")}"></label>
        <label>Report language<select name="report_lang"><option value="fr" ${b.default_report_language !== "en" ? "selected" : ""}>French first</option><option value="en" ${b.default_report_language === "en" ? "selected" : ""}>English first</option></select></label>
        <label class="wide">Client logo (image link, optional)<input name="logo_url" type="url" value="${esc(b.logo_url || "")}" placeholder="https://…/logo.png"></label>
        <label class="wide">Your agency name<input name="agency" value="${esc(b.agency || "MJR Comms")}"></label>
      </div>
    </fieldset>
    <div class="row">
      <button class="btn primary" type="submit">${isNew ? "Add game" : "Save changes"}</button>
      <button class="btn" type="button" data-act="cancelgame">Cancel</button>
      ${isNew ? "" : `<span class="spacer"></span><button class="btn" type="button" data-act="pausegame" data-id="${esc(p.id)}">${p.active === false ? "Resume tracking" : "Pause tracking"}</button><button class="btn danger" type="button" data-act="deletegame" data-id="${esc(p.id)}">Remove game</button>`}
    </div>
  </form>`;
}

function sectionGames() {
  const editing = state.editingGame;
  const rows = state.projects
    .map((p) =>
      editing && editing.id === p.id
        ? gameFormHtml(editing)
        : `<div class="gamerow"><span class="swatch" style="background:${esc(p.branding?.primary_color || "#5b3fd1")}"></span>
          <div class="grow"><b>${esc(p.name)}</b>${p.client ? ` <span class="muted">— ${esc(p.client)}</span>` : ""}${p.active === false ? ` <span class="tag">paused</span>` : ""}
          <div class="muted small">Searching for: ${esc((p.keywords || [p.name]).map((k) => k.replace(/"/g, "")).join(", "))}</div></div>
          ${state.gh ? `<button class="btn small" data-act="editgame" data-id="${esc(p.id)}">Edit</button>` : ""}</div>`,
    )
    .join("");
  return `<section class="panel" id="set-games"><h2>Your games</h2>
    ${rows || `<p class="muted">No games yet.</p>`}
    ${editing && !editing.id ? gameFormHtml(editing) : state.gh ? `<button class="btn primary" data-act="newgame">+ Add a game</button>` : `<p class="muted small">Connect GitHub to add or edit games.</p>`}
  </section>`;
}

function sectionKeys() {
  const has = (n) => state.secrets?.has(n);
  return `<section class="panel" id="set-keys"><h2>Services &amp; keys</h2>
    <p class="muted">Keys are encrypted and stored as GitHub secrets: nobody (including you) can read them back, only replace them. Every service is optional; add what you have.</p>
    ${SERVICES.map((svc) => {
      const set = svc.names.every(has);
      return `<form class="keyrow" data-names="${esc(svc.names.join(","))}">
        <div class="keyhead"><b>${esc(svc.label)}</b> ${set ? `<span class="ok">✅ Connected</span>` : `<span class="muted">Not set</span>`}</div>
        <p class="muted small">${esc(svc.why)} <a href="${esc(svc.link)}" target="_blank" rel="noopener">${esc(svc.linkText)} ↗</a></p>
        <div class="row wrap">${svc.names
          .map((n) => `<input type="password" name="${esc(n)}" autocomplete="off" placeholder="${esc(n.replace(/_/g, " ").toLowerCase())}${set ? " (leave empty to keep)" : ""}" aria-label="${esc(n)}" class="grow">`)
          .join("")}<button class="btn" type="submit">Save</button>${set ? `<button class="btn ghost" type="button" data-act="delkey">Remove</button>` : ""}</div>
      </form>`;
    }).join("")}
  </section>`;
}

function sectionAi() {
  const cur = state.settings.classifier_model || "claude-opus-5-5";
  return `<section class="panel" id="set-ai"><h2>AI filter</h2>
    <p class="muted">Which Claude model checks each result. Each new result costs one short request; Haiku is plenty for most games.</p>
    <form id="aiForm" class="row wrap"><select name="model" class="grow">${MODELS.map(([id, l]) => `<option value="${id}" ${id === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select><button class="btn" type="submit">Save</button></form>
  </section>`;
}

function sectionOutlets() {
  const rows = state.outlets
    .map(
      (o, i) => `<tr data-i="${i}">
      <td><input name="name" value="${esc(o.name)}" aria-label="Name"></td>
      <td><input name="domain" value="${esc(o.domain)}" aria-label="Website"></td>
      <td><input name="feed" value="${esc(o.feed || "")}" placeholder="(none)" aria-label="RSS feed"></td>
      <td><select name="lang" aria-label="Language">${["fr", "en"].map((l) => `<option ${o.lang === l ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><select name="tier" aria-label="Tier">${["A", "B", "C"].map((t) => `<option ${o.tier === t ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><button class="btn small ghost" type="button" data-act="deloutlet" aria-label="Remove">✕</button></td></tr>`,
    )
    .join("");
  return `<section class="panel" id="set-outlets"><h2>News outlets &amp; tiers</h2>
    <p class="muted">Outlets checked directly through their news feed, and the tier shown in reports: <b>A</b> major national or games media, <b>B</b> specialist or regional, <b>C</b> small blog. Outlets without a feed are still found through Google News; listing them here gives them the right tier.</p>
    <form id="outletsForm"><div class="table-wrap"><table class="edit"><thead><tr><th>Name</th><th>Website</th><th>News feed (RSS)</th><th>Lang</th><th>Tier</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row"><button class="btn" type="button" data-act="addoutlet">+ Add outlet</button><button class="btn primary" type="submit">Save outlets</button></div></form>
  </section>`;
}

function sectionAdvanced() {
  const base = `https://github.com/${repoSlug.owner}/${repoSlug.repo}`;
  const last = lastFinishedRun();
  return `<section class="panel" id="set-advanced"><h2>Behind the scenes</h2>
    <ul class="plain">
      <li>Automatic checks: every 30 minutes. Last: ${last ? `${esc(ago(last.updated_at))} — ${last.conclusion === "success" ? "✅ OK" : `⚠ ${esc(last.conclusion)}`} (<a href="${esc(last.html_url)}" target="_blank" rel="noopener">details</a>)` : "none yet"}</li>
      <li><a href="${base}/actions/workflows/poll.yml" target="_blank" rel="noopener">History of all checks ↗</a></li>
      <li><a href="${base}" target="_blank" rel="noopener">Your repository on GitHub ↗</a></li>
      <li>Classifier used in the last update: ${esc(state.data.classifier || "—")}</li>
    </ul>
    ${(state.data.poll_state || []).length ? `<details><summary>Status of each source</summary><div class="table-wrap"><table><thead><tr><th>Source</th><th>Last check</th><th>Result</th></tr></thead><tbody>${state.data.poll_state
      .map((r) => `<tr><td>${esc(r.key)}</td><td>${esc(ago(r.last_run_at))}</td><td>${r.last_status === "ok" ? "✅" : "⚠"} ${esc(r.last_message)}</td></tr>`)
      .join("")}</tbody></table></div></details>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- game save
const slug = (s) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "game";
const lines = (s) => String(s || "").split(/\n|,/).map((x) => x.trim()).filter(Boolean);

async function saveGame(form) {
  const fd = new FormData(form);
  const get = (k) => String(fd.get(k) ?? "").trim();
  const name = get("name");
  const existingId = form.dataset.id;
  let id = existingId || slug(name);
  if (!existingId) while (state.projects.some((p) => p.id === id)) id = `${id}-2`;
  const prev = state.projects.find((p) => p.id === existingId) || {};
  const keywordsPlain = lines(get("keywords")).length ? lines(get("keywords")) : [name];
  const languages = ["fr", "en"].filter((l) => fd.get(l));
  const webhook = get("webhook");
  const webhookEnv = `DISCORD_WEBHOOK_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const project = {
    ...prev,
    id,
    name,
    client: get("client"),
    active: prev.active ?? true,
    keywords: keywordsPlain.map((k) => (/\s/.test(k) ? `"${k}"` : k)),
    required_terms: keywordsPlain.map((k) => k.toLowerCase()),
    exclude_terms: lines(get("exclude")),
    context: get("context"),
    languages: languages.length ? languages : ["fr", "en"],
    sources: {
      ...(prev.sources || {}),
      rss: Boolean(fd.get("web")),
      google_news: Boolean(fd.get("web")),
      youtube: { ...(prev.sources?.youtube || {}), enabled: Boolean(fd.get("youtube")), queries: prev.sources?.youtube?.queries?.length && existingId ? prev.sources.youtube.queries : [], every_hours: Number(get("yt_hours")) || 6 },
      twitch: { ...(prev.sources?.twitch || {}), enabled: Boolean(fd.get("twitch")), game_name: get("twitch_name") || name, game_id: prev.sources?.twitch?.game_name === get("twitch_name") ? prev.sources?.twitch?.game_id || "" : "" },
      reddit: { ...(prev.sources?.reddit || {}), enabled: Boolean(fd.get("reddit")), queries: [] },
      bluesky: { ...(prev.sources?.bluesky || {}), enabled: Boolean(fd.get("bluesky")), queries: [] },
    },
    alerts: {
      ...(prev.alerts || {}),
      discord_webhook_env: webhook ? webhookEnv : prev.alerts?.discord_webhook_env || "",
      notify_streams: Boolean(fd.get("notify_streams")),
    },
    branding: {
      ...(prev.branding || {}),
      primary_color: get("primary_color"),
      accent_color: get("accent_color"),
      logo_url: get("logo_url"),
      agency: get("agency"),
      default_report_language: get("report_lang") || "fr",
    },
  };
  // keyword changes invalidate custom per-source queries
  if (existingId && JSON.stringify(prev.keywords) !== JSON.stringify(project.keywords)) {
    project.sources.youtube.queries = [];
  }
  if (webhook) {
    if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(webhook)) throw new Error("That doesn't look like a Discord webhook URL (it should start with https://discord.com/api/webhooks/).");
    await state.gh.setSecret(webhookEnv, webhook);
    state.secrets?.add(webhookEnv);
  }
  const saved = await state.gh.updateJson(
    "config/projects.json",
    (j) => {
      j.projects ??= [];
      const i = j.projects.findIndex((p) => p.id === id);
      if (i >= 0) j.projects[i] = project;
      else j.projects.push(project);
      return j;
    },
    `Dashboard: ${existingId ? "update" : "add"} game ${name}`,
    { projects: [] },
  );
  state.projects = saved.projects;
  state.project = id;
  store("gpc.project", id);
  state.editingGame = null;
  toast(existingId ? "Game saved ✓" : `${name} added ✓ — the first check starts in a minute or two.`);
  render();
  setTimeout(refreshRuns, 5000);
}

async function mutateProjects(fn, message) {
  const saved = await state.gh.updateJson("config/projects.json", (j) => (fn(j), j), message, { projects: [] });
  state.projects = saved.projects;
  if (!state.projects.some((p) => p.id === state.project)) state.project = state.projects[0]?.id || "";
  render();
}

// ---------------------------------------------------------------- report
function openReportDialog() {
  const p = currentProject();
  if (!p) return toast("Add a game first.", true);
  const d = $("#reportDialog");
  const f = $("form", d);
  f.from.value = new Date(Date.now() - state.days * 86400_000).toISOString().slice(0, 10);
  f.to.value = today();
  f.lang.value = p.branding?.default_report_language || "fr";
  d.showModal();
}

function reportHtml(f) {
  const p = currentProject();
  const sel = selectForReport(p, allHits(), state.data.streams, f.from.value, f.to.value);
  return { html: renderReport(p, { ...sel, from: f.from.value, to: f.to.value, lang: f.lang.value }), name: `${p.id}_${f.from.value}_${f.to.value}.html` };
}

// ---------------------------------------------------------------- events
function bind() {
  $("#project").onchange = (e) => {
    state.project = e.target.value;
    store("gpc.project", state.project);
    state.editingGame = null;
    render();
  };
  $$("#range button").forEach((b) => (b.onclick = () => {
    state.days = Number(b.dataset.days);
    store("gpc.days", state.days);
    render();
  }));
  $("#checkBtn").onclick = checkNow;
  $("#reportBtn").onclick = openReportDialog;

  $("#reportDialog form").addEventListener("submit", (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    const { html, name } = reportHtml(e.target);
    if (action === "open") {
      const w = window.open("", "_blank");
      if (!w) return toast("Your browser blocked the new tab. Use “Download file” instead.", true);
      w.document.open();
      w.document.write(html);
      w.document.close();
    } else if (action === "download") {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([html], { type: "text/html" })), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });

  window.addEventListener("hashchange", () => {
    state.view = location.hash.slice(1) || "coverage";
    render();
  });

  const view = $("#view");
  view.addEventListener("input", (e) => {
    const id = e.target.id;
    const map = { "f-q": "q", "f-kind": "kind", "f-lang": "lang", "f-tier": "tier", "f-sent": "sent" };
    if (map[id]) {
      state.filters[map[id]] = e.target.value;
      renderList();
    }
  });
  view.addEventListener("change", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName !== "SELECT") return;
    if (t.dataset.act === "tier") queueOp({ type: "override", key: t.dataset.key, fields: { tier: t.value || null } });
    if (t.dataset.act === "sent") queueOp({ type: "override", key: t.dataset.key, fields: { sentiment: t.value } });
  });
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT") return;
    const act = t.dataset.act;
    try {
      switch (act) {
        case "connect":
        case "step-connect":
          return goSettings("connect");
        case "step-keys":
          return goSettings("keys");
        case "step-games":
          state.editingGame = state.editingGame || (state.gh ? { name: "" } : null);
          return goSettings("games");
        case "step-check":
          return checkNow();
        case "keep":
          return queueOp({ type: "override", key: t.dataset.key, fields: { relevant: true } });
        case "reject":
          return queueOp({ type: "override", key: t.dataset.key, fields: { relevant: false } });
        case "delmanual":
          if (confirm("Delete this entry?")) queueOp({ type: "removeManual", id: t.dataset.mid });
          return;
        case "dups": {
          const id = t.dataset.id;
          expandedDups.has(id) ? expandedDups.delete(id) : expandedDups.add(id);
          return renderList();
        }
        case "disconnect":
          store("gpc.token", null);
          state.gh = null;
          state.canWrite = false;
          state.secrets = null;
          state.runs = [];
          toast("Disconnected. This browser no longer stores your token.");
          return reloadAll();
        case "newgame":
          state.editingGame = { name: "" };
          return render();
        case "editgame":
          state.editingGame = structuredClone(state.projects.find((p) => p.id === t.dataset.id));
          return render();
        case "cancelgame":
          state.editingGame = null;
          return render();
        case "pausegame": {
          const id = t.dataset.id;
          state.editingGame = null;
          await mutateProjects((j) => {
            const p = j.projects.find((x) => x.id === id);
            if (p) p.active = p.active === false;
          }, "Dashboard: pause/resume game");
          return toast("Saved ✓");
        }
        case "deletegame": {
          const p = state.projects.find((x) => x.id === t.dataset.id);
          if (!confirm(`Stop tracking ${p.name} and remove it? Coverage already collected is kept in the database.`)) return;
          state.editingGame = null;
          await mutateProjects((j) => (j.projects = j.projects.filter((x) => x.id !== p.id)), `Dashboard: remove game ${p.name}`);
          return toast(`${p.name} removed.`);
        }
        case "addoutlet":
          collectOutletRows();
          state.outlets.push({ name: "", domain: "", feed: "", lang: "fr", region: "", tier: "B" });
          render();
          return $("#outletsForm tbody tr:last-child input")?.focus();
        case "deloutlet":
          collectOutletRows();
          state.outlets.splice(Number(t.closest("tr").dataset.i), 1);
          return render();
        case "delkey": {
          const names = t.closest("form").dataset.names.split(",");
          if (!confirm("Remove this key? The service will stop being used.")) return;
          for (const n of names) if (state.secrets?.has(n)) await state.gh.deleteSecret(n);
          names.forEach((n) => state.secrets?.delete(n));
          render();
          return toast("Key removed.");
        }
      }
    } catch (err) {
      toast(friendlyError(err), true);
    }
  });

  view.addEventListener("click", (e) => {
    const b = e.target.closest("#langSeg button");
    if (!b) return;
    state.lang = b.dataset.lang;
    store("gpc.lang", state.lang);
    $$("#langSeg button").forEach((x) => x.classList.toggle("on", x === b));
    renderList();
  });

  view.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      if (form.id === "connectForm") {
        const token = new FormData(form).get("token").trim();
        await connect(token);
        await reloadAll();
        toast("Connected ✓");
        if (state.access.noSecrets || state.access.noActions) goSettings("connect");
      } else if (form.id === "manualForm") {
        const entry = Object.fromEntries([...new FormData(form)].filter(([, v]) => String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()]));
        entry.id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        entry.project_id = state.project;
        entry.added_at = new Date().toISOString();
        queueOp({ type: "addManual", entry });
        toast("Added ✓");
      } else if (form.id === "gameForm") {
        await saveGame(form);
      } else if (form.classList.contains("keyrow")) {
        const fd = new FormData(form);
        const values = form.dataset.names.split(",").map((n) => [n, String(fd.get(n) || "").trim()]);
        const filled = values.filter(([, v]) => v);
        if (!filled.length) return toast("Paste the key first.", true);
        for (const [n, v] of filled) {
          await state.gh.setSecret(n, v);
          state.secrets?.add(n);
        }
        render();
        toast("Key saved securely ✓");
      } else if (form.id === "aiForm") {
        const model = new FormData(form).get("model");
        state.settings = await state.gh.updateJson("config/settings.json", (j) => ({ ...j, classifier_model: model }), "Dashboard: change AI model", {});
        toast("Saved ✓");
      } else if (form.id === "outletsForm") {
        collectOutletRows();
        const clean = state.outlets
          .map((o) => ({ ...o, domain: o.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""), name: o.name.trim(), feed: o.feed.trim() }))
          .filter((o) => o.name && o.domain);
        const saved = await state.gh.updateJson("config/outlets.json", (j) => ({ ...j, outlets: clean }), "Dashboard: update outlets", { outlets: [] });
        state.outlets = saved.outlets;
        render();
        toast("Outlets saved ✓");
      }
    } catch (err) {
      toast(friendlyError(err), true);
    } finally {
      if (btn && document.contains(btn)) btn.disabled = false;
    }
  });
}

function collectOutletRows() {
  $$("#outletsForm tbody tr").forEach((tr) => {
    const o = state.outlets[Number(tr.dataset.i)];
    if (!o) return;
    for (const el of $$("input, select", tr)) o[el.name] = el.value;
  });
}

// ---------------------------------------------------------------- start
async function init() {
  bind();
  state.view = location.hash.slice(1) || "coverage";
  const token = recall("gpc.token");
  if (token && !LOCAL) {
    const ok = await connect(token, { quiet: true }).catch(() => false);
    if (!ok) toast("Your saved GitHub token no longer works. Please reconnect in Settings.", true);
  }
  try {
    await Promise.all([loadConfig(), loadData()]);
  } catch (err) {
    toast(`Couldn't load data: ${err.message}`, true);
  }
  state.loaded = true;
  render();
  if (state.gh) runTimer = setTimeout(refreshRuns, activeRun() ? 8000 : 60000);
  // refresh published data every 5 minutes for view-only visitors too
  setInterval(() => !state.ops.length && !state.saving && loadData().then(safeRender).catch(() => {}), 5 * 60_000);
}

init();
