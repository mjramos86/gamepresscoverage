// Reddit search. Uses app-only OAuth when REDDIT_CLIENT_ID/SECRET are set (reliable from
// cloud runners), otherwise falls back to the public JSON endpoint.
import { fetchJson, canonicalUrl } from "../lib/util.js";

let token;
async function oauthToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret } = process.env;
  const data = await fetchJson("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent(),
    },
    body: "grant_type=client_credentials",
  });
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

const userAgent = () => process.env.REDDIT_USER_AGENT || "gamepresscoverage/0.1";

export async function collectReddit(project, log = console) {
  const cfg = project.sources.reddit;
  const queries = cfg.queries?.length ? cfg.queries : project.keywords;
  const useOauth = process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET;
  const hits = [];
  for (const q of queries) {
    const path = `/search.json?q=${encodeURIComponent(q)}&sort=new&t=week&limit=100&raw_json=1`;
    const data = useOauth
      ? await fetchJson(`https://oauth.reddit.com${path}`, { headers: { authorization: `Bearer ${await oauthToken()}`, "user-agent": userAgent() } })
      : await fetchJson(`https://www.reddit.com${path}`, { headers: { "user-agent": userAgent() } });
    for (const { data: p } of data.data?.children ?? []) {
      const url = `https://www.reddit.com${p.permalink}`;
      hits.push({
        project_id: project.id,
        source: "reddit",
        medium: "social",
        platform: "reddit",
        url,
        canonical_url: canonicalUrl(url),
        title: p.title,
        snippet: (p.selftext || p.url || "").slice(0, 1000),
        author: `u/${p.author}`,
        outlet: `r/${p.subreddit}`,
        outlet_domain: "reddit.com",
        published_at: new Date(p.created_utc * 1000).toISOString(),
        likes: p.score,
        comments: p.num_comments,
        audience: p.subreddit_subscribers ?? null,
        type: "social",
      });
    }
  }
  log.info(`  reddit[${project.id}]: ${hits.length} posts`);
  return hits;
}
