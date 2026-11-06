// Bluesky app.bsky.feed.searchPosts. Authenticated if BLUESKY_HANDLE/APP_PASSWORD are set
// (the public AppView may reject unauthenticated search), otherwise tries the public AppView.
import { fetchJson, canonicalUrl } from "../lib/util.js";

let session;
async function authHeader() {
  const { BLUESKY_HANDLE: identifier, BLUESKY_APP_PASSWORD: password } = process.env;
  if (!identifier || !password) return null;
  if (!session) {
    session = await fetchJson("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
  }
  return { authorization: `Bearer ${session.accessJwt}` };
}

export async function collectBluesky(project, log = console) {
  const cfg = project.sources.bluesky;
  const queries = cfg.queries?.length ? cfg.queries : project.keywords;
  const auth = await authHeader();
  const base = auth ? "https://bsky.social/xrpc" : "https://public.api.bsky.app/xrpc";
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const hits = [];
  for (const q of queries) {
    const data = await fetchJson(`${base}/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&limit=100&since=${since}`, {
      headers: auth ?? {},
    });
    for (const p of data.posts ?? []) {
      const rkey = p.uri.split("/").pop();
      const url = `https://bsky.app/profile/${p.author.handle}/post/${rkey}`;
      hits.push({
        project_id: project.id,
        source: "bluesky",
        medium: "social",
        platform: "bluesky",
        url,
        canonical_url: canonicalUrl(url),
        title: (p.record?.text || "").slice(0, 140),
        snippet: p.record?.text || "",
        author: p.author.displayName ? `${p.author.displayName} (@${p.author.handle})` : `@${p.author.handle}`,
        outlet: "Bluesky",
        outlet_domain: "bsky.app",
        published_at: p.record?.createdAt ?? p.indexedAt,
        lang: p.record?.langs?.[0]?.slice(0, 2) ?? null,
        likes: p.likeCount ?? null,
        comments: p.replyCount ?? null,
        views: null,
        type: "social",
      });
    }
  }
  log.info(`  bluesky[${project.id}]: ${hits.length} posts`);
  return hits;
}
