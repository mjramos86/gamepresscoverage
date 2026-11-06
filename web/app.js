// Dashboard: works against the local server (/api/data, read-write) or a static export (data.json, read-only).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { data: null, mode: "static", project: "", days: 30, lang: "en", tab: "coverage", token: "" };
const ICON = { rss: "📰", google_news: "📰", youtube: "▶️", twitch: "🟣", reddit: "👽", bluesky: "🦋", manual: "📝" };
const SOURCE_LABEL = { rss: "Outlet RSS", google_news: "Google News", youtube: "YouTube", twitch: "Twitch", reddit: "Reddit", bluesky: "Bluesky", manual: "Manual" };
const nf = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n) => (n == null ? "—" : nf.format(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (h) => h.published_at || h.discovered_at;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(state.lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", year: "numeric" }) : "");

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

async function fetchData() {
  try {
    const res = await fetch("api/data", { cache: "no-store" });
    if (!res.ok) throw new Error();
    state.mode = "server";
    return await res.json();
  } catch {
    const res = await fetch("data.json", { cache: "no-store" });
    state.mode = "static";
    return await res.json();
  }
}

async function api(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers["x-dashboard-token"] = state.token;
  let res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    state.token = prompt("Dashboard token") || "";
    save("gpc.token", state.token);
    headers["x-dashboard-token"] = state.token;
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

function inRange(h) {
  return Date.parse(when(h)) >= Date.now() - state.days * 86400_000;
}

function projectHits() {
  return state.data.hits.filter((h) => h.project_id === state.project && inRange(h));
}
function projectStreams() {
  return state.data.streams.filter((s) => s.project_id === state.project && Date.parse(s.started_at) >= Date.now() - state.days * 86400_000);
}
function streamMetrics(s) {
  const end = Date.parse(s.ended_at || s.last_seen_at || s.started_at);
  const hours = Math.max(0, (end - Date.parse(s.started_at)) / 3_600_000);
  const avg = s.samples ? s.viewer_sum / s.samples : 0;
  return { hours, avg, hoursWatched: hours * avg };
}

function renderKpis() {
  const hits = projectHits().filter((h) => h.relevant === 1);
  const orig = hits.filter((h) => !h.duplicate_of);
  const streams = projectStreams();
  const sm = streams.map(streamMetrics);
  const videos = orig.filter((h) => h.medium === "video");
  const pos = orig.filter((h) => h.sentiment === "positive").length;
  const withSent = orig.filter((h) => h.sentiment).length;
  const kpis = [
    ["Coverage pieces", orig.length + streams.length],
    ["Tier A", orig.filter((h) => h.tier === "A").length],
    ["Unique outlets", new Set(orig.filter((h) => ["web", "print", "broadcast", "podcast"].includes(h.medium)).map((h) => h.outlet_domain || h.outlet)).size],
    ["Syndications", hits.length - orig.length],
    ["YouTube views", videos.reduce((s, h) => s + (h.views || 0), 0)],
    ["Twitch streams", streams.length],
    ["Hours watched", Math.round(sm.reduce((s, m) => s + m.hoursWatched, 0))],
    ["Peak viewers", streams.reduce((m, s) => Math.max(m, s.peak_viewers || 0), 0)],
    ["Positive", withSent ? `${Math.round((pos / withSent) * 100)}%` : "—"],
    ["French", orig.length ? `${Math.round((orig.filter((h) => h.lang === "fr").length / orig.length) * 100)}%` : "—"],
  ];
  $("#kpis").innerHTML = kpis.map(([l, v]) => `<div class="kpi"><b>${typeof v === "number" ? fmt(v) : esc(v)}</b><span>${esc(l)}</span></div>`).join("");
}

function renderChart() {
  const days = Math.min(state.days, 90);
  const hits = projectHits().filter((h) => h.relevant === 1 && !h.duplicate_of);
  const buckets = new Map();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) buckets.set(new Date(start - i * 86400_000).toISOString().slice(0, 10), 0);
  for (const h of hits) {
    const k = new Date(when(h)).toISOString().slice(0, 10);
    if (buckets.has(k)) buckets.set(k, buckets.get(k) + 1);
  }
  const entries = [...buckets];
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const W = 1000, H = 140, pad = 18, bw = (W - pad) / entries.length;
  const bars = entries.map(([d, v], i) => {
    const h = (v / max) * (H - 30);
    return `<rect class="bar" x="${pad + i * bw + 1}" y="${H - 16 - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${d}: ${v}</title></rect>`;
  }).join("");
  const labels = entries.filter((_, i) => i % Math.ceil(entries.length / 8) === 0)
    .map(([d]) => `<text class="axis" x="${pad + entries.findIndex(([x]) => x === d) * bw}" y="${H - 3}">${d.slice(5)}</text>`).join("");
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Coverage per day">
    <line class="grid" x1="${pad}" x2="${W}" y1="${H - 16}" y2="${H - 16}"/>
    <text class="axis" x="0" y="12">${max}</text>${bars}${labels}</svg>`;
  $("#chartNote").textContent = `last ${days} days · originals only`;
}

function hitCard(h, { review = false } = {}) {
  const el = $("#hitTpl").content.firstElementChild.cloneNode(true);
  if (h.duplicate_of) el.classList.add("dup");
  if (h.relevant === 0) el.classList.add("rejected");
  const thumb = $(".thumb", el);
  thumb.href = h.url.startsWith("http") ? h.url : "#";
  if (h.thumbnail) thumb.style.backgroundImage = `url("${h.thumbnail.replace(/"/g, "")}")`;
  else thumb.textContent = ICON[h.source] || "•";
  const meta = [
    `<span>${ICON[h.source] || ""} ${esc(h.outlet || h.platform || SOURCE_LABEL[h.source])}</span>`,
    h.tier ? `<span class="tag tier ${esc(h.tier)}">${esc(h.tier)}</span>` : "",
    `<span>${esc(fmtDate(when(h)))}</span>`,
    h.lang ? `<span class="tag">${esc(h.lang.toUpperCase())}</span>` : "",
    h.type ? `<span class="tag">${esc(h.type)}</span>` : "",
    h.sentiment ? `<span class="sent ${esc(h.sentiment)}">${esc(h.sentiment)}</span>` : "",
    h.duplicate_of ? `<span class="tag">syndication</span>` : "",
  ];
  $(".meta", el).innerHTML = meta.join("");
  const title = $(".title", el);
  title.textContent = h.title || h.url;
  title.href = h.url.startsWith("http") ? h.url : "#";
  const summary = state.lang === "fr" ? h.summary_fr || h.summary_en : h.summary_en || h.summary_fr;
  $(".summary", el).textContent = summary && summary !== h.title ? summary : (h.snippet || "").slice(0, 220);
  const foot = [
    h.author && h.author !== h.outlet ? `by ${esc(h.author)}` : "",
    h.views ? `${fmt(h.views)} views` : "",
    h.likes ? `${fmt(h.likes)} likes` : "",
    h.comments ? `${fmt(h.comments)} comments` : "",
    h.audience ? `${fmt(h.audience)} audience` : "",
    review || h.relevant === 0 ? `<em>${esc(h.relevance_reason || "")}${h.relevance_confidence != null ? ` (${Math.round(h.relevance_confidence * 100)}%)` : ""}</em>` : "",
    `<span title="classifier">${esc(h.classified_by || "pending")}</span>`,
  ];
  $(".foot", el).innerHTML = foot.filter(Boolean).map((x) => `<span>${x}</span>`).join("");

  const actions = $(".actions", el);
  if (state.mode === "server") {
    actions.innerHTML = `
      <button class="yes ${h.relevant === 1 ? "on" : ""}" title="Relevant">✓ Relevant</button>
      <button class="no ${h.relevant === 0 ? "on" : ""}" title="Not relevant">✗ Not</button>
      <select class="tier-sel" aria-label="Tier"><option value="">Tier —</option>${["A", "B", "C"].map((t) => `<option ${h.tier === t ? "selected" : ""}>${t}</option>`).join("")}</select>
      <select class="sent-sel" aria-label="Sentiment">${state.data.enums.sentiments.map((s) => `<option ${h.sentiment === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      ${h.source === "manual" ? `<button class="del">Delete</button>` : ""}`;
    const patch = async (body) => {
      try {
        Object.assign(h, await api("PATCH", `api/hits/${h.id}`, body));
        render();
      } catch (err) { alert(err.message); }
    };
    $(".yes", actions).onclick = () => patch({ relevant: true });
    $(".no", actions).onclick = () => patch({ relevant: false });
    $(".tier-sel", actions).onchange = (e) => patch({ tier: e.target.value });
    $(".sent-sel", actions).onchange = (e) => patch({ sentiment: e.target.value });
    const del = $(".del", actions);
    if (del) del.onclick = async () => {
      if (!confirm("Delete this manual entry?")) return;
      await api("DELETE", `api/hits/${h.id}`);
      state.data.hits = state.data.hits.filter((x) => x.id !== h.id);
      render();
    };
  }
  return el;
}

function renderList() {
  const q = $("#q").value.trim().toLowerCase();
  const f = (id) => $(id).value;
  const showDups = $("#f-dups").checked;
  let hits = projectHits().filter((h) => h.relevant === 1);
  hits = hits.filter((h) =>
    (!q || `${h.title} ${h.outlet} ${h.author} ${h.summary_en} ${h.summary_fr}`.toLowerCase().includes(q)) &&
    (!f("#f-medium") || h.medium === f("#f-medium")) &&
    (!f("#f-source") || h.source === f("#f-source")) &&
    (!f("#f-tier") || h.tier === f("#f-tier")) &&
    (!f("#f-lang") || h.lang === f("#f-lang")) &&
    (!f("#f-type") || h.type === f("#f-type")) &&
    (!f("#f-sent") || h.sentiment === f("#f-sent")));
  const originals = hits.filter((h) => !h.duplicate_of);
  const dupsByOrig = new Map();
  for (const h of hits.filter((x) => x.duplicate_of)) dupsByOrig.set(h.duplicate_of, [...(dupsByOrig.get(h.duplicate_of) || []), h]);
  const list = $("#list");
  list.replaceChildren();
  if (!originals.length) {
    list.innerHTML = `<div class="empty">No coverage matches these filters yet.</div>`;
    return;
  }
  for (const h of originals) {
    const card = hitCard(h);
    const dups = dupsByOrig.get(h.id) || [];
    if (dups.length) $(".foot", card).insertAdjacentHTML("afterbegin", `<span class="tag">+${dups.length} syndication${dups.length > 1 ? "s" : ""}</span>`);
    list.append(card);
    if (showDups) for (const d of dups) list.append(hitCard(d));
  }
}

function renderReview() {
  const items = projectHits()
    .filter((h) => !h.manual_override && (h.relevant === 0 || (h.relevant === 1 && (h.relevance_confidence ?? 1) < 0.7)) && h.classified_by !== "prefilter" && !h.duplicate_of)
    .sort((a, b) => (b.relevance_confidence ?? 0) - (a.relevance_confidence ?? 0));
  $("#reviewCount").textContent = items.length || "";
  const el = $("#review");
  el.replaceChildren(...items.slice(0, 200).map((h) => hitCard(h, { review: true })));
  if (!items.length) el.innerHTML = `<div class="empty">Nothing to review 🎉</div>`;
}

function renderStreams() {
  const streams = projectStreams();
  if (!streams.length) {
    $("#streams").innerHTML = `<div class="empty">No Twitch streams logged in this period. Make sure the game has a Twitch category and the project's <code>sources.twitch</code> is enabled.</div>`;
    return;
  }
  $("#streams").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Streamer</th><th>Title</th><th class="r">Followers</th><th class="r">Duration</th><th class="r">Avg</th><th class="r">Peak</th><th class="r">Hours watched</th></tr></thead><tbody>${streams
    .map((s) => {
      const m = streamMetrics(s);
      return `<tr><td>${esc(fmtDate(s.started_at))} ${s.ended_at ? "" : '<span class="live">● LIVE</span>'}</td>
        <td><a href="https://twitch.tv/${esc(s.user_login)}" target="_blank" rel="noopener">${esc(s.user_name)}</a> <span class="tag">${esc((s.language || "").toUpperCase())}</span></td>
        <td>${esc(s.title)}</td><td class="r">${fmt(s.followers)}</td><td class="r">${m.hours.toFixed(1)} h</td>
        <td class="r">${fmt(Math.round(m.avg))}</td><td class="r">${fmt(s.peak_viewers)}</td><td class="r">${fmt(Math.round(m.hoursWatched))}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

function renderSources() {
  const rows = state.data.poll_state || [];
  $("#sources").innerHTML = `<p class="muted">Classifier: <b>${esc(state.data.classifier)}</b> · Data generated ${esc(new Date(state.data.generated_at).toLocaleString())} · Mode: ${esc(state.mode)}</p>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Last run</th><th>Status</th><th>Message</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td>${esc(r.key)}</td><td>${esc(new Date(r.last_run_at).toLocaleString())}</td><td>${r.last_status === "ok" ? "✅" : "⚠️"} ${esc(r.last_status)}</td><td class="muted">${esc(r.last_message)}</td></tr>`)
      .join("")}</tbody></table></div>` : `<div class="empty">No polls have run yet. Run <code>npm run poll</code>.</div>`}`;
}

function renderReportLink() {
  const btn = $("#reportBtn");
  if (state.mode === "server") {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - state.days * 86400_000).toISOString().slice(0, 10);
    btn.href = `report?project=${encodeURIComponent(state.project)}&from=${from}&to=${to}&lang=${state.lang}`;
  } else btn.href = `reports/${encodeURIComponent(state.project)}-last-30-days.html`;
}

function render() {
  const p = state.data.projects.find((x) => x.id === state.project);
  if (p?.branding?.primary_color) document.documentElement.style.setProperty("--accent", p.branding.primary_color);
  renderKpis(); renderChart(); renderList(); renderStreams(); renderSources(); renderReportLink();
  if (state.mode === "server") renderReview();
}

function fillSelect(sel, values, labels = {}) {
  for (const v of values) sel.insertAdjacentHTML("beforeend", `<option value="${esc(v)}">${esc(labels[v] || v)}</option>`);
}

async function init() {
  state.data = await fetchData();
  document.body.classList.toggle("static", state.mode === "static");
  state.token = load("gpc.token", "");
  state.project = load("gpc.project", "");
  if (!state.data.projects.some((p) => p.id === state.project)) state.project = state.data.projects[0]?.id || "";
  state.days = Number(load("gpc.days", 30));
  state.lang = load("gpc.lang", "en");

  const sel = $("#project");
  sel.innerHTML = state.data.projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.client ? ` — ${esc(p.client)}` : ""}</option>`).join("");
  sel.value = state.project;
  sel.onchange = () => { state.project = sel.value; save("gpc.project", state.project); render(); };

  const { types, sentiments, media } = state.data.enums;
  fillSelect($("#f-medium"), media); fillSelect($("#f-type"), types); fillSelect($("#f-sent"), sentiments);
  fillSelect($("#f-source"), Object.keys(SOURCE_LABEL), SOURCE_LABEL);
  fillSelect($("#m-type"), types); fillSelect($("#m-sent"), sentiments);
  $("#m-type").value = "social";

  const segs = (id, key, attr, cast = String) => {
    for (const b of $$(`#${id} button`)) {
      b.classList.toggle("on", String(state[key]) === b.dataset[attr]);
      b.onclick = () => {
        state[key] = cast(b.dataset[attr]); save(`gpc.${key}`, state[key]);
        $$(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
        render();
      };
    }
  };
  segs("range", "days", "days", Number);
  segs("lang", "lang", "lang");

  for (const b of $$("#tabs button")) b.onclick = () => {
    $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab").forEach((t) => t.classList.toggle("on", t.id === `tab-${b.dataset.tab}`));
  };
  for (const id of ["#q", "#f-medium", "#f-source", "#f-tier", "#f-lang", "#f-type", "#f-sent", "#f-dups"]) $(id).addEventListener("input", renderList);

  $("#pollBtn").onclick = async () => {
    const btn = $("#pollBtn");
    btn.disabled = true; btn.textContent = "Polling…";
    try {
      await api("POST", "api/poll", { force: true, project_id: state.project });
      // poll runs in the background; refresh until it finishes
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const d = await fetchData();
        state.data = d; render();
        if (!d.polling) break;
      }
    } catch (err) { alert(err.message); }
    btn.disabled = false; btn.textContent = "Poll now";
  };

  $("#manualForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.project_id = state.project;
    $("#manualMsg").textContent = "Saving…";
    try {
      const hit = await api("POST", "api/hits", body);
      state.data.hits.unshift(hit);
      e.target.reset(); $("#m-type").value = "social";
      $("#manualMsg").textContent = `Added “${hit.title}”.`;
      render();
    } catch (err) { $("#manualMsg").textContent = `Error: ${err.message}`; }
  };

  $("#status").textContent = state.mode === "static" ? `Read-only snapshot · ${new Date(state.data.generated_at).toLocaleString()}` : "";
  render();
}

init().catch((err) => {
  document.querySelector("main").innerHTML = `<div class="empty">Could not load data: ${esc(err.message)}. Run <code>npm run serve</code> or <code>npm run export</code>.</div>`;
});
