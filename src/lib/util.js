// Shared helpers: HTTP, URL canonicalisation, fingerprints, language guess, tiers.
import { loadOutlets } from "./config.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, opts = {}, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { "user-agent": "gamepresscoverage/0.1 (+press coverage monitor)", ...(opts.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  const body = await res.text();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${redact(url)}: ${body.replace(/\s+/g, " ").slice(0, 200)}`), { status: res.status });
  return JSON.parse(body);
}

// Never log API keys that live in query strings.
export function redact(url) {
  return String(url).replace(/([?&](key|token|access_token|client_secret)=)[^&]+/gi, "$1***");
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|taid|xtor|at_medium|at_campaign|guccounter|feature|si)$/i;

export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp)\./, "");
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    // YouTube: keep only the video id
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.searchParams.get("v")) return `https://youtube.com/watch?v=${u.searchParams.get("v")}`;
    if (u.hostname === "youtu.be") return `https://youtube.com/watch?v=${u.pathname.slice(1)}`;
    let p = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "");
    const q = u.searchParams.toString();
    return `${u.protocol}//${u.hostname}${p}${q ? "?" + q : ""}`;
  } catch {
    return String(raw || "").trim();
  }
}

export function domainOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^(www|m|amp)\./, "");
  } catch {
    return "";
  }
}

export function stripHtml(s = "") {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Title fingerprint used for syndication / repost dedup.
// Google News titles end with " - Outlet name"; strip that.
export function titleTokens(title = "") {
  const t = normalizeText(String(title).replace(/\s[-|–—]\s[^-|–—]{2,40}$/, ""));
  return new Set(t.split(" ").filter((w) => w.length > 2));
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const FR_WORDS = new Set("le la les des une est et dans pour sur avec que qui pas plus sont jeu jeux nouveau nouvelle ce cette du au aux son ses leur été être fait très mais ou".split(" "));
const EN_WORDS = new Set("the and is are for with that this from was were has have new game games its their on of to in an be by it not but you".split(" "));

export function guessLanguage(text = "") {
  const words = normalizeText(text).split(" ");
  let fr = 0, en = 0;
  for (const w of words) {
    if (FR_WORDS.has(w)) fr++;
    if (EN_WORDS.has(w)) en++;
  }
  if (/[éèêàçùâîôû]/i.test(text)) fr += 1;
  if (fr === 0 && en === 0) return "other";
  return fr > en ? "fr" : "en";
}

export function matchesTerms(text, terms) {
  const t = normalizeText(text);
  return terms.some((term) => t.includes(normalizeText(term)));
}

let outletIndex;
export function outletForDomain(domain) {
  if (!outletIndex) {
    outletIndex = new Map();
    for (const o of loadOutlets()) outletIndex.set(o.domain.toLowerCase(), o);
  }
  if (!domain) return undefined;
  let d = domain.toLowerCase();
  while (d.includes(".")) {
    if (outletIndex.has(d)) return outletIndex.get(d);
    d = d.slice(d.indexOf(".") + 1);
  }
  return undefined;
}

export const TIER_ORDER = { A: 3, B: 2, C: 1 };
export function tierAtLeast(tier, min) {
  if (!min) return true;
  return (TIER_ORDER[tier] || 0) >= (TIER_ORDER[min] || 0);
}

export function isoOrNull(d) {
  if (!d) return null;
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
