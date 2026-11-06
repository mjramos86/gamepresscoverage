// Bilingual (FR/EN), client-branded HTML coverage report. Print to PDF from the browser.
import { queryHits, queryStreams } from "./lib/db.js";
import { escapeHtml as e } from "./lib/util.js";

const L = {
  title: ["Rapport de couverture médiatique", "Media coverage report"],
  period: ["Période", "Period"],
  preparedBy: ["Préparé par", "Prepared by"],
  overview: ["Vue d'ensemble", "Overview"],
  pieces: ["Retombées", "Coverage pieces"],
  tierA: ["Médias de niveau A", "Tier A outlets"],
  outlets: ["Médias uniques", "Unique outlets"],
  syndications: ["Reprises", "Syndications"],
  videos: ["Vidéos YouTube", "YouTube videos"],
  views: ["Vues YouTube", "YouTube views"],
  streams: ["Diffusions Twitch", "Twitch streams"],
  hoursWatched: ["Heures regardées (est.)", "Hours watched (est.)"],
  peak: ["Pic de spectateurs", "Peak viewers"],
  social: ["Publications sociales", "Social posts"],
  sentiment: ["Tonalité", "Sentiment"],
  language: ["Langue", "Language"],
  highlights: ["Faits saillants", "Highlights"],
  web: ["Presse web", "Web press"],
  video: ["Vidéo", "Video"],
  stream: ["Diffusions en direct", "Live streams"],
  socialSec: ["Réseaux sociaux", "Social media"],
  offline: ["Imprimé, radio/télé et autres", "Print, broadcast & other"],
  date: ["Date", "Date"],
  outlet: ["Média", "Outlet"],
  tier: ["Niveau", "Tier"],
  headline: ["Titre", "Headline"],
  type: ["Type", "Type"],
  summary: ["Résumé", "Summary"],
  channel: ["Chaîne", "Channel"],
  subs: ["Abonnés", "Subscribers"],
  streamer: ["Créateur", "Streamer"],
  duration: ["Durée", "Duration"],
  avg: ["Moy. spectateurs", "Avg viewers"],
  followers: ["Abonnés", "Followers"],
  engagement: ["Engagement", "Engagement"],
  none: ["Aucune retombée pour cette période.", "No coverage in this period."],
  methodology: ["Méthodologie", "Methodology"],
  methodText: [
    "Les retombées sont collectées automatiquement (fils RSS de médias sélectionnés, Google Actualités, YouTube, Twitch, Reddit, Bluesky) puis validées par un filtre de pertinence assisté par IA, et complétées manuellement (TikTok, Instagram, X, imprimé, radio/télé). Les articles repris par plusieurs médias sont regroupés. Niveaux de médias : A = média national ou majeur du jeu vidéo, B = média spécialisé ou régional établi, C = blogue ou petit média. Les heures regardées sur Twitch sont estimées à partir d'échantillons de spectateurs.",
    "Coverage is collected automatically (curated outlet RSS feeds, Google News, YouTube, Twitch, Reddit, Bluesky), validated by an AI-assisted relevance filter, and complemented by manual logging (TikTok, Instagram, X, print, broadcast). Syndicated copies of the same story are grouped. Outlet tiers: A = national or major games outlet, B = established specialist or regional outlet, C = blog or small outlet. Twitch hours watched are estimated from sampled viewer counts.",
  ],
  types: {
    review: ["Critique", "Review"], preview: ["Aperçu", "Preview"], news: ["Nouvelle", "News"], feature: ["Reportage", "Feature"],
    interview: ["Entrevue", "Interview"], guide: ["Guide", "Guide"], listicle: ["Liste", "Listicle"], video: ["Vidéo", "Video"],
    stream: ["Diffusion", "Stream"], social: ["Social", "Social"], other: ["Autre", "Other"],
  },
  sentiments: { positive: ["Positive", "Positive"], neutral: ["Neutre", "Neutral"], negative: ["Négative", "Negative"], mixed: ["Mitigée", "Mixed"] },
};

const both = ([fr, en]) => `<span lang="fr">${e(fr)}</span><span lang="en">${e(en)}</span>`;
const nf = (n, lang) => (n == null ? "—" : Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA").format(Math.round(n)));
const num = (n) => `<span lang="fr">${nf(n, "fr")}</span><span lang="en">${nf(n, "en")}</span>`;
const dateCell = (d) => (d ? `<span lang="fr">${new Date(d).toLocaleDateString("fr-CA", { day: "numeric", month: "short", year: "numeric" })}</span><span lang="en">${new Date(d).toLocaleDateString("en-CA", { day: "numeric", month: "short", year: "numeric" })}</span>` : "—");

export function streamMetrics(s) {
  const end = Date.parse(s.ended_at || s.last_seen_at || s.started_at);
  const hours = Math.max(0, (end - Date.parse(s.started_at)) / 3_600_000);
  const avg = s.samples ? s.viewer_sum / s.samples : 0;
  return { hours, avg, hoursWatched: hours * avg };
}

export function computeStats(hits, streams) {
  const originals = hits.filter((h) => !h.duplicate_of);
  const web = originals.filter((h) => ["web"].includes(h.medium));
  const videos = originals.filter((h) => h.medium === "video");
  const social = originals.filter((h) => h.medium === "social");
  const sm = streams.map(streamMetrics);
  const count = (arr, key) => arr.reduce((m, h) => ((m[h[key] || "unknown"] = (m[h[key] || "unknown"] || 0) + 1), m), {});
  return {
    pieces: originals.length + streams.length,
    syndications: hits.length - originals.length,
    tierA: originals.filter((h) => h.tier === "A").length,
    outlets: new Set(originals.filter((h) => ["web", "print", "broadcast", "podcast"].includes(h.medium)).map((h) => h.outlet_domain || h.outlet)).size,
    videos: videos.length,
    videoViews: videos.reduce((s, h) => s + (h.views || 0), 0),
    streams: streams.length,
    hoursStreamed: sm.reduce((s, m) => s + m.hours, 0),
    hoursWatched: sm.reduce((s, m) => s + m.hoursWatched, 0),
    peakViewers: streams.reduce((m, s) => Math.max(m, s.peak_viewers || 0), 0),
    social: social.length,
    web: web.length,
    sentiment: count(originals, "sentiment"),
    language: count(originals, "lang"),
  };
}

function bar(dist, labels) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  const colors = { positive: "#16a34a", neutral: "#9ca3af", negative: "#dc2626", mixed: "#eab308", fr: "var(--primary)", en: "var(--accent)" };
  const segs = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div style="flex:${v};background:${colors[k] || "#cbd5e1"}" title="${e(k)}: ${v}"></div>`)
    .join("");
  const legend = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li><i style="background:${colors[k] || "#cbd5e1"}"></i>${labels?.[k] ? both(labels[k]) : e(k.toUpperCase())} <b>${Math.round((v / total) * 100)}%</b></li>`)
    .join("");
  return `<div class="bar">${segs}</div><ul class="legend">${legend}</ul>`;
}

function summaryCell(h) {
  const fr = h.summary_fr || h.summary_en || "";
  const en = h.summary_en || h.summary_fr || "";
  return `<span lang="fr">${e(fr)}</span><span lang="en">${e(en)}</span>`;
}

const typeLabel = (t) => (L.types[t] ? both(L.types[t]) : e(t || ""));
const sentDot = (s) => (s ? `<span class="dot ${e(s)}" title="${e(s)}"></span>` : "");

function syndicationNote(h, dupMap) {
  const d = dupMap.get(h.id);
  if (!d?.length) return "";
  const names = [...new Set(d.map((x) => x.outlet || x.outlet_domain))].slice(0, 6).join(", ");
  return `<div class="synd">+${d.length} ${both(["reprise(s)", "syndication(s)"])}: ${e(names)}</div>`;
}

export function buildReport(project, { from, to, lang } = {}) {
  const fromIso = from ? new Date(from + "T00:00:00").toISOString() : undefined;
  const toIso = to ? new Date(to + "T23:59:59").toISOString() : undefined;
  const hits = queryHits({ projectId: project.id, from: fromIso, to: toIso });
  const streams = queryStreams({ projectId: project.id, from: fromIso, to: toIso });
  const stats = computeStats(hits, streams);
  const b = project.branding;
  const defaultLang = lang || b.default_report_language || "fr";

  const dupMap = new Map();
  for (const h of hits.filter((x) => x.duplicate_of)) dupMap.set(h.duplicate_of, [...(dupMap.get(h.duplicate_of) || []), h]);
  const originals = hits.filter((h) => !h.duplicate_of);
  const byMedium = (m) => originals.filter((h) => m.includes(h.medium));
  const web = byMedium(["web"]).sort((a, b) => (b.tier || "Z") < (a.tier || "Z") ? 1 : -1);
  const videos = byMedium(["video"]).sort((a, b) => (b.views || 0) - (a.views || 0));
  const social = byMedium(["social"]).sort((a, b) => (b.likes || 0) + (b.views || 0) - (a.likes || 0) - (a.views || 0));
  const offline = byMedium(["print", "broadcast", "podcast"]);

  const tierRank = { A: 0, B: 1, C: 2 };
  const highlights = [
    ...web.filter((h) => h.tier === "A" || h.type === "review").sort((a, b) => (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3)).slice(0, 4),
    ...videos.slice(0, 2),
  ].slice(0, 6);

  const kpis = [
    [L.pieces, stats.pieces], [L.tierA, stats.tierA], [L.outlets, stats.outlets], [L.syndications, stats.syndications],
    [L.videos, stats.videos], [L.views, stats.videoViews], [L.streams, stats.streams], [L.hoursWatched, stats.hoursWatched],
    [L.peak, stats.peakViewers], [L.social, stats.social],
  ].filter(([, v], i) => i < 4 || v > 0);

  const webRows = web
    .map(
      (h) => `<tr><td class="nowrap">${dateCell(h.published_at || h.discovered_at)}</td><td>${e(h.outlet || h.outlet_domain || "")}${h.lang ? ` <small>${e(h.lang.toUpperCase())}</small>` : ""}</td>
      <td class="c">${h.tier ? `<span class="tier t${e(h.tier)}">${e(h.tier)}</span>` : "—"}</td>
      <td><a href="${e(h.url)}">${e(h.title || h.url)}</a><div class="sum">${sentDot(h.sentiment)}${summaryCell(h)}</div>${syndicationNote(h, dupMap)}</td><td>${typeLabel(h.type)}</td></tr>`,
    )
    .join("");
  const videoRows = videos
    .map(
      (h) => `<tr><td class="nowrap">${dateCell(h.published_at)}</td><td>${e(h.author || "")}</td><td class="r">${num(h.audience)}</td>
      <td><a href="${e(h.url)}">${e(h.title)}</a><div class="sum">${sentDot(h.sentiment)}${summaryCell(h)}</div></td><td class="r">${num(h.views)}</td></tr>`,
    )
    .join("");
  const streamRows = streams
    .map((s) => {
      const m = streamMetrics(s);
      return `<tr><td class="nowrap">${dateCell(s.started_at)}</td><td><a href="https://twitch.tv/${e(s.user_login)}">${e(s.user_name)}</a> <small>${e((s.language || "").toUpperCase())}</small><div class="sum">${e(s.title || "")}</div></td>
      <td class="r">${num(s.followers)}</td><td class="r">${m.hours.toFixed(1)} h</td><td class="r">${num(m.avg)}</td><td class="r">${num(s.peak_viewers)}</td></tr>`;
    })
    .join("");
  const socialRows = social
    .map(
      (h) => `<tr><td class="nowrap">${dateCell(h.published_at)}</td><td>${e(h.platform || h.source)}</td><td>${e(h.author || "")}${h.outlet && h.outlet !== h.platform ? ` <small>${e(h.outlet)}</small>` : ""}</td>
      <td><a href="${e(h.url)}">${e((h.title || h.snippet || h.url).slice(0, 140))}</a><div class="sum">${sentDot(h.sentiment)}${summaryCell(h)}</div></td>
      <td class="r">${[h.views ? `${nf(h.views, "en")} 👁` : "", h.likes ? `${nf(h.likes, "en")} ♥` : "", h.comments ? `${nf(h.comments, "en")} 💬` : ""].filter(Boolean).join(" · ") || "—"}</td></tr>`,
    )
    .join("");
  const offlineRows = offline
    .map(
      (h) => `<tr><td class="nowrap">${dateCell(h.published_at)}</td><td>${e(h.outlet || "")} <small>${e(h.medium)}</small></td><td class="c">${h.tier ? `<span class="tier t${e(h.tier)}">${e(h.tier)}</span>` : "—"}</td>
      <td>${h.url?.startsWith("http") ? `<a href="${e(h.url)}">${e(h.title)}</a>` : e(h.title)}<div class="sum">${sentDot(h.sentiment)}${summaryCell(h)}</div></td><td class="r">${num(h.audience)}</td></tr>`,
    )
    .join("");

  const section = (label, head, rows) =>
    rows ? `<section><h2>${both(label)}</h2><table><thead><tr>${head.map((h) => `<th>${both(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></section>` : "";

  return `<!doctype html>
<html lang="${defaultLang}" data-lang="${defaultLang}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(project.name)} — ${e(L.title[defaultLang === "fr" ? 0 : 1])} ${e(from || "")} → ${e(to || "")}</title>
<style>
  :root { --primary: ${e(b.primary_color)}; --accent: ${e(b.accent_color)}; --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#fff; --soft:#f9fafb; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); }
  html[data-lang="fr"] [lang="en"], html[data-lang="en"] [lang="fr"] { display: none; }
  header { background: var(--primary); color: #fff; padding: 40px 48px 32px; }
  header .top { display:flex; justify-content:space-between; align-items:center; gap:16px; }
  header img { max-height: 48px; }
  header h1 { margin: 24px 0 4px; font-size: 32px; letter-spacing: -0.02em; }
  header p { margin: 0; opacity: .85; }
  .toggle { display:flex; gap:4px; background: rgba(255,255,255,.15); border-radius: 999px; padding: 3px; }
  .toggle button { border:0; background:transparent; color:#fff; font:inherit; font-weight:600; padding:4px 12px; border-radius:999px; cursor:pointer; }
  html[data-lang="fr"] .toggle [data-l="fr"], html[data-lang="en"] .toggle [data-l="en"] { background:#fff; color: var(--primary); }
  main { padding: 32px 48px 48px; max-width: 1200px; margin: 0 auto; }
  h2 { font-size: 18px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 3px solid var(--accent); display:inline-block; }
  .kpis { display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .kpi { background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .kpi b { display:block; font-size: 26px; color: var(--primary); font-variant-numeric: tabular-nums; }
  .kpi .lbl { display:block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .dists { display:grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px; }
  .dists h3 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing:.04em; margin: 0 0 6px; }
  .bar { display:flex; height: 12px; border-radius: 6px; overflow:hidden; background: var(--line); }
  .legend { list-style:none; padding:0; margin: 8px 0 0; display:flex; flex-wrap:wrap; gap: 4px 14px; font-size: 12px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
  .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card { border:1px solid var(--line); border-left: 4px solid var(--primary); border-radius: 8px; padding: 12px 14px; }
  .card .meta { font-size: 12px; color: var(--muted); }
  .card a { font-weight: 600; color: var(--ink); text-decoration: none; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  th { text-align:left; font-size: 11px; text-transform: uppercase; letter-spacing:.04em; color: var(--muted); border-bottom: 2px solid var(--line); padding: 6px 8px; }
  td { border-bottom: 1px solid var(--line); padding: 8px; vertical-align: top; }
  td a { color: var(--ink); font-weight: 600; text-decoration: none; } td a:hover { text-decoration: underline; }
  .sum { color: #374151; font-size: 12.5px; margin-top: 2px; }
  .synd { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
  .nowrap { white-space: nowrap; } .r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; } .c { text-align:center; }
  small { color: var(--muted); }
  .tier { display:inline-block; min-width: 22px; text-align:center; font-weight:700; font-size: 11px; border-radius: 4px; padding: 1px 5px; color:#fff; }
  .tA { background: var(--primary); } .tB { background: #6b7280; } .tC { background: #9ca3af; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align: 1px; }
  .dot.positive{background:#16a34a}.dot.neutral{background:#9ca3af}.dot.negative{background:#dc2626}.dot.mixed{background:#eab308}
  .empty { color: var(--muted); }
  footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); margin-top: 40px; padding-top: 16px; display:flex; justify-content:space-between; gap: 24px; align-items:flex-end; }
  footer img { max-height: 28px; }
  @media (max-width: 700px) { header, main { padding-left: 16px; padding-right: 16px; } .dists { grid-template-columns: 1fr; } table { display:block; overflow-x:auto; } }
  @media print {
    .toggle { display:none; } header { -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 24px 32px; }
    main { padding: 16px 32px; } .kpi, .card, .bar, .tier, .dot, .legend i { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tr, .card { break-inside: avoid; } a { color: inherit; }
  }
</style>
</head>
<body>
<header>
  <div class="top">
    <div>${b.logo_url ? `<img src="${e(b.logo_url)}" alt="${e(project.client || project.name)}">` : `<strong>${e(project.client || "")}</strong>`}</div>
    <div class="toggle"><button data-l="fr">FR</button><button data-l="en">EN</button></div>
  </div>
  <h1>${e(project.name)}</h1>
  <p>${both(L.title)} · ${both(L.period)} ${dateCell(from)} – ${dateCell(to)}</p>
</header>
<main>
  <h2>${both(L.overview)}</h2>
  <div class="kpis">${kpis.map(([label, v]) => `<div class="kpi"><b>${num(v)}</b><span class="lbl">${both(label)}</span></div>`).join("")}</div>
  ${stats.pieces ? `<div class="dists"><div><h3>${both(L.sentiment)}</h3>${bar(stats.sentiment, L.sentiments)}</div><div><h3>${both(L.language)}</h3>${bar(stats.language)}</div></div>` : `<p class="empty">${both(L.none)}</p>`}

  ${highlights.length ? `<h2>${both(L.highlights)}</h2><div class="cards">${highlights
    .map((h) => `<div class="card"><div class="meta">${e(h.outlet || h.author || "")}${h.tier ? ` · Tier ${e(h.tier)}` : ""}${h.views ? ` · ${num(h.views)} 👁` : ""}</div><a href="${e(h.url)}">${e(h.title)}</a><div class="sum">${sentDot(h.sentiment)}${summaryCell(h)}</div></div>`)
    .join("")}</div>` : ""}

  ${section(L.web, [L.date, L.outlet, L.tier, L.headline, L.type], webRows)}
  ${section(L.video, [L.date, L.channel, L.subs, L.headline, ["Vues", "Views"]], videoRows)}
  ${section(L.stream, [L.date, L.streamer, L.followers, L.duration, L.avg, L.peak], streamRows)}
  ${section(L.socialSec, [L.date, ["Plateforme", "Platform"], ["Compte", "Account"], ["Publication", "Post"], L.engagement], socialRows)}
  ${section(L.offline, [L.date, L.outlet, L.tier, L.headline, ["Auditoire", "Audience"]], offlineRows)}

  <h2>${both(L.methodology)}</h2>
  <p class="sum">${both(L.methodText)}</p>
  <footer>
    <div>${both(L.preparedBy)} ${e(b.agency || "")} · ${dateCell(new Date().toISOString())}</div>
    ${b.agency_logo_url ? `<img src="${e(b.agency_logo_url)}" alt="${e(b.agency)}">` : ""}
  </footer>
</main>
<script>
  document.querySelectorAll(".toggle button").forEach((btn) => btn.addEventListener("click", () => {
    document.documentElement.dataset.lang = btn.dataset.l; document.documentElement.lang = btn.dataset.l;
  }));
</script>
</body>
</html>`;
}
