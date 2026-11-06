// YouTube Data API v3. search.list costs 100 units (10,000/day free => ~100 searches/day),
// videos.list and channels.list cost 1 unit each. A daily budget guard keeps us under quota.
import { fetchJson, canonicalUrl } from "../lib/util.js";
import { addUsage, usageToday } from "../lib/db.js";

const API = "https://www.googleapis.com/youtube/v3";
const DAILY_BUDGET = Number(process.env.YOUTUBE_DAILY_UNITS || 9000);

export async function collectYouTube(project, log = console) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    log.info(`  youtube[${project.id}]: skipped (no YOUTUBE_API_KEY)`);
    return [];
  }
  const cfg = project.sources.youtube;
  const queries = cfg.queries?.length ? cfg.queries : project.keywords;
  const publishedAfter = new Date(Date.now() - 7 * 86400_000).toISOString();
  const videoIds = new Set();
  for (const q of queries) {
    if (usageToday("youtube") + 100 > DAILY_BUDGET) {
      log.warn(`  youtube: daily unit budget reached (${DAILY_BUDGET}), skipping remaining searches`);
      break;
    }
    const url = `${API}/search?part=id&type=video&order=date&maxResults=50&publishedAfter=${publishedAfter}&q=${encodeURIComponent(q)}&key=${key}`;
    const data = await fetchJson(url);
    addUsage("youtube", 100);
    for (const item of data.items ?? []) if (item.id?.videoId) videoIds.add(item.id.videoId);
  }
  if (!videoIds.size) return [];

  const videos = [];
  const ids = [...videoIds];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await fetchJson(`${API}/videos?part=snippet,statistics&id=${ids.slice(i, i + 50).join(",")}&key=${key}`);
    addUsage("youtube", 1);
    videos.push(...(data.items ?? []));
  }
  const channelIds = [...new Set(videos.map((v) => v.snippet.channelId))];
  const subs = new Map();
  for (let i = 0; i < channelIds.length; i += 50) {
    const data = await fetchJson(`${API}/channels?part=statistics&id=${channelIds.slice(i, i + 50).join(",")}&key=${key}`);
    addUsage("youtube", 1);
    for (const c of data.items ?? []) subs.set(c.id, c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount));
  }

  const hits = videos.map((v) => {
    const url = `https://www.youtube.com/watch?v=${v.id}`;
    return {
      project_id: project.id,
      source: "youtube",
      medium: "video",
      url,
      canonical_url: canonicalUrl(url),
      title: v.snippet.title,
      snippet: (v.snippet.description || "").slice(0, 1000),
      author: v.snippet.channelTitle,
      outlet: v.snippet.channelTitle,
      outlet_domain: "youtube.com",
      published_at: v.snippet.publishedAt,
      lang: (v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || "").slice(0, 2) || null,
      views: Number(v.statistics?.viewCount ?? 0),
      likes: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
      comments: v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null,
      audience: subs.get(v.snippet.channelId) ?? null,
      thumbnail: v.snippet.thumbnails?.medium?.url ?? null,
      type: "video",
    };
  });
  log.info(`  youtube[${project.id}]: ${hits.length} videos`);
  return hits;
}
