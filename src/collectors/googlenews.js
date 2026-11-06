// Google News RSS search per keyword, in French (Canada) and English (Canada) editions.
import { parseFeed } from "./feedparse.js";
import { fetchWithRetry, canonicalUrl, domainOf, outletForDomain, matchesTerms } from "../lib/util.js";

const EDITIONS = {
  fr: { hl: "fr-CA", gl: "CA", ceid: "CA:fr" },
  en: { hl: "en-CA", gl: "CA", ceid: "CA:en" },
};

export function googleNewsUrl(query, lang) {
  const e = EDITIONS[lang] ?? EDITIONS.en;
  const q = encodeURIComponent(`${query} when:30d`);
  return `https://news.google.com/rss/search?q=${q}&hl=${e.hl}&gl=${e.gl}&ceid=${e.ceid}`;
}

export async function collectGoogleNews(project, log = console) {
  const hits = [];
  for (const lang of project.languages.filter((l) => EDITIONS[l])) {
    for (const kw of project.keywords) {
      const res = await fetchWithRetry(googleNewsUrl(kw, lang));
      if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
      const feed = parseFeed(await res.text());
      for (const item of feed.items) {
        if (project.exclude_terms.length && matchesTerms(item.title, project.exclude_terms)) continue;
        // Links are news.google.com redirect URLs; the real outlet is in <source url>.
        const outletDomain = domainOf(item.sourceUrl) || domainOf(item.link);
        const outlet = outletForDomain(outletDomain);
        hits.push({
          project_id: project.id,
          source: "google_news",
          medium: "web",
          url: item.link,
          canonical_url: canonicalUrl(item.link),
          title: item.title,
          snippet: item.description,
          outlet: outlet?.name ?? item.sourceName ?? outletDomain,
          outlet_domain: outletDomain,
          tier: outlet?.tier ?? null,
          published_at: item.published,
          lang: outlet?.lang ?? lang,
        });
      }
    }
  }
  log.info(`  google_news[${project.id}]: ${hits.length} items`);
  return hits;
}
