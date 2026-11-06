import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

const SOURCE_DEFAULTS = {
  rss: true,
  google_news: true,
  youtube: { enabled: false, queries: [], every_hours: 6 },
  twitch: { enabled: false, game_id: "", game_name: "", min_viewers: 0 },
  reddit: { enabled: false, queries: [] },
  bluesky: { enabled: false, queries: [] },
};

export function normalizeProject(p) {
  const sources = { ...SOURCE_DEFAULTS };
  for (const [k, v] of Object.entries(p.sources || {})) {
    sources[k] = typeof SOURCE_DEFAULTS[k] === "object" && typeof v === "object" ? { ...SOURCE_DEFAULTS[k], ...v } : v;
  }
  const keywords = (p.keywords?.length ? p.keywords : [`"${p.name}"`]).map(String);
  return {
    active: true,
    languages: ["fr", "en"],
    exclude_terms: [],
    context: "",
    ...p,
    keywords,
    // terms that must appear (case-insensitive) for a cheap pre-filter on outlet RSS items
    required_terms: (p.required_terms?.length ? p.required_terms : keywords.map((k) => k.replace(/"/g, ""))).map((t) => t.toLowerCase()),
    sources,
    alerts: { discord_webhook_env: "", slack_webhook_env: "", min_tier: "", notify_streams: true, ...(p.alerts || {}) },
    branding: {
      primary_color: "#1f2937",
      accent_color: "#2563eb",
      logo_url: "",
      agency: "MJR Comms",
      agency_logo_url: "",
      default_report_language: "fr",
      ...(p.branding || {}),
    },
  };
}

export function loadProjects({ includeInactive = false } = {}) {
  const { projects } = readJson("config/projects.json");
  return projects.map(normalizeProject).filter((p) => includeInactive || p.active);
}

export function loadOutlets() {
  return readJson("config/outlets.json").outlets;
}

export function getProject(id) {
  return loadProjects({ includeInactive: true }).find((p) => p.id === id);
}
