// Twitch Helix: poll live streams in the game's category and track sessions
// (who streamed, start time, duration, peak and average viewers).
import { fetchJson } from "../lib/util.js";
import { openDb } from "../lib/db.js";

let token; // { value, expiresAt }

async function appToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const { TWITCH_CLIENT_ID: id, TWITCH_CLIENT_SECRET: secret } = process.env;
  const data = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function helix(path) {
  return fetchJson(`https://api.twitch.tv/helix/${path}`, {
    headers: { "client-id": process.env.TWITCH_CLIENT_ID, authorization: `Bearer ${await appToken()}` },
  });
}

export async function resolveGameId(name) {
  const data = await helix(`games?name=${encodeURIComponent(name)}`);
  return data.data?.[0]?.id ?? null;
}

/** Returns { newStreams, live, ended } for alerting. */
export async function pollTwitch(project, log = console) {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    log.info(`  twitch[${project.id}]: skipped (no TWITCH_CLIENT_ID/SECRET)`);
    return { newStreams: [], live: [], ended: [] };
  }
  const cfg = project.sources.twitch;
  let gameId = cfg.game_id;
  if (!gameId) {
    gameId = await resolveGameId(cfg.game_name || project.name);
    if (!gameId) {
      log.warn(`  twitch[${project.id}]: no Twitch category named "${cfg.game_name || project.name}" yet`);
      return { newStreams: [], live: [], ended: [] };
    }
    log.info(`  twitch[${project.id}]: resolved game_id ${gameId} (add it to config to save a call)`);
  }

  const live = [];
  let cursor = "";
  do {
    const page = await helix(`streams?game_id=${gameId}&first=100${cursor ? `&after=${cursor}` : ""}`);
    live.push(...page.data);
    cursor = page.pagination?.cursor ?? "";
  } while (cursor && live.length < 1000);

  const db = openDb();
  const now = new Date().toISOString();
  const newStreams = [];
  const seen = new Set();
  for (const s of live.filter((x) => x.viewer_count >= (cfg.min_viewers || 0))) {
    seen.add(s.id);
    const existing = db.prepare("SELECT stream_id FROM streams WHERE stream_id = ?").get(s.id);
    const thumb = s.thumbnail_url?.replace("{width}", "320").replace("{height}", "180");
    if (existing) {
      db.prepare(
        `UPDATE streams SET last_seen_at = ?, ended_at = NULL, title = ?, peak_viewers = MAX(peak_viewers, ?),
         viewer_sum = viewer_sum + ?, samples = samples + 1, thumbnail = ? WHERE stream_id = ?`,
      ).run(now, s.title, s.viewer_count, s.viewer_count, thumb, s.id);
    } else {
      db.prepare(
        `INSERT INTO streams (stream_id, project_id, user_id, user_login, user_name, title, language, started_at, last_seen_at,
         peak_viewers, viewer_sum, samples, thumbnail) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      ).run(s.id, project.id, s.user_id, s.user_login, s.user_name, s.title, s.language, s.started_at, now, s.viewer_count, s.viewer_count, thumb);
      newStreams.push(s);
    }
  }

  // Follower counts for newly seen channels (1 call each; only for new streams)
  for (const s of newStreams) {
    try {
      const f = await helix(`channels/followers?broadcaster_id=${s.user_id}&first=1`);
      db.prepare("UPDATE streams SET followers = ? WHERE stream_id = ?").run(f.total ?? null, s.id);
      s.followers = f.total;
    } catch {
      /* follower endpoint may be restricted; non-fatal */
    }
  }

  // Anything open for this project that we didn't see this time has ended.
  const open = db.prepare("SELECT * FROM streams WHERE project_id = ? AND ended_at IS NULL").all(project.id);
  const ended = open.filter((r) => !seen.has(r.stream_id));
  for (const r of ended) db.prepare("UPDATE streams SET ended_at = last_seen_at WHERE stream_id = ?").run(r.stream_id);

  log.info(`  twitch[${project.id}]: ${live.length} live, ${newStreams.length} new, ${ended.length} ended`);
  return { newStreams, live, ended };
}
