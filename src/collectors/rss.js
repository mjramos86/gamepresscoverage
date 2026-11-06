// Curated outlet RSS feeds. Each feed is fetched once per run and matched against every project.
import { parseFeed } from "./feedparse.js";
import { loadOutlets } from "../lib/config.js";
import { fetchWithRetry, canonicalUrl, domainOf, matchesTerms } from "../lib/util.js";

export async function fetchFeed(url) {
  const res = await fetchWithRetry(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text());
}

export async function collectOutletFeeds(projects, log = console) {
  const outlets = loadOutlets().filter((o) => o.feed);
  const byProject = new Map(projects.map((p) => [p.id, []]));
  const results = await Promise.allSettled(outlets.map(async (o) => ({ outlet: o, feed: await fetchFeed(o.feed) })));
  let ok = 0;
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      log.warn(`  rss: ${outlets[i].name} failed: ${r.reason?.message}`);
      continue;
    }
    ok++;
    const { outlet, feed } = r.value;
    for (const item of feed.items) {
      const haystack = `${item.title} ${item.description}`;
      for (const p of projects) {
        if (!p.sources.rss) continue;
        if (!matchesTerms(haystack, p.required_terms)) continue;
        if (p.exclude_terms.length && matchesTerms(haystack, p.exclude_terms)) continue;
        byProject.get(p.id).push({
          project_id: p.id,
          source: "rss",
          medium: "web",
          url: item.link,
          canonical_url: canonicalUrl(item.link),
          title: item.title,
          snippet: item.description,
          author: item.author,
          outlet: outlet.name,
          outlet_domain: outlet.domain || domainOf(item.link),
          tier: outlet.tier,
          published_at: item.published,
          lang: outlet.lang,
          thumbnail: item.thumbnail || null,
        });
      }
    }
  }
  log.info(`  rss: ${ok}/${outlets.length} feeds OK`);
  return byProject;
}
