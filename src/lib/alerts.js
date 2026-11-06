// Discord / Slack webhook alerts for new relevant hits and new live streams.
import { fetchWithRetry, tierAtLeast } from "./util.js";

const EMOJI = { rss: "📰", google_news: "📰", youtube: "▶️", twitch: "🟣", reddit: "👽", bluesky: "🦋", manual: "📝" };
const SENT = { positive: "🟢", neutral: "⚪", negative: "🔴", mixed: "🟡" };

function webhooks(project) {
  const discord = (project.alerts.discord_webhook_env && process.env[project.alerts.discord_webhook_env]) || process.env.DISCORD_WEBHOOK_URL;
  const slack = (project.alerts.slack_webhook_env && process.env[project.alerts.slack_webhook_env]) || process.env.SLACK_WEBHOOK_URL;
  return { discord, slack };
}

const fmt = (n) => (n == null ? "" : Intl.NumberFormat("en", { notation: "compact" }).format(n));

function hitLine(h) {
  const bits = [
    h.tier ? `Tier ${h.tier}` : null,
    h.type,
    h.lang?.toUpperCase(),
    h.views ? `${fmt(h.views)} views` : null,
    h.audience ? `${fmt(h.audience)} subs/followers` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

async function post(url, body) {
  const res = await fetchWithRetry(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function alertHits(project, hits, log = console) {
  const eligible = hits.filter((h) => tierAtLeast(h.tier, project.alerts.min_tier) || !["rss", "google_news"].includes(h.source));
  if (!eligible.length) return [];
  const { discord, slack } = webhooks(project);
  if (!discord && !slack) return [];
  // Discord allows 10 embeds per message
  for (let i = 0; i < eligible.length; i += 10) {
    const batch = eligible.slice(i, i + 10);
    if (discord) {
      await post(discord, {
        username: "Press Coverage",
        content: i === 0 ? `**${eligible.length} new hit${eligible.length > 1 ? "s" : ""} for ${project.name}**` : undefined,
        embeds: batch.map((h) => ({
          title: `${EMOJI[h.source] ?? "•"} ${(h.title || h.url).slice(0, 240)}`,
          url: h.url,
          description: [h.summary_en, `${SENT[h.sentiment] ?? ""} ${hitLine(h)}`].filter(Boolean).join("\n").slice(0, 2000),
          author: { name: [h.outlet, h.author].filter(Boolean).join(" — ").slice(0, 250) || h.source },
          color: parseInt((project.branding.primary_color || "#5865F2").replace("#", ""), 16),
          timestamp: h.published_at || undefined,
          thumbnail: h.thumbnail ? { url: h.thumbnail } : undefined,
        })),
      });
    }
    if (slack) {
      await post(slack, {
        text: `${eligible.length} new hit(s) for ${project.name}`,
        blocks: batch.flatMap((h) => [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${EMOJI[h.source] ?? "•"} *<${h.url}|${(h.title || h.url).replace(/[<>|]/g, "").slice(0, 200)}>*\n${[h.outlet, h.author].filter(Boolean).join(" — ")}\n${h.summary_en ?? ""}\n_${SENT[h.sentiment] ?? ""} ${hitLine(h)}_`,
            },
          },
        ]),
      });
    }
  }
  log.info(`  alerts[${project.id}]: sent ${eligible.length} hit(s)`);
  return eligible.map((h) => h.id);
}

export async function alertStreams(project, streams, log = console) {
  if (!streams.length || !project.alerts.notify_streams) return;
  const { discord, slack } = webhooks(project);
  for (const s of streams.slice(0, 10)) {
    const url = `https://twitch.tv/${s.user_login}`;
    const line = `${fmt(s.viewer_count)} viewers${s.followers ? ` · ${fmt(s.followers)} followers` : ""} · ${s.language?.toUpperCase() ?? ""}`;
    if (discord)
      await post(discord, {
        username: "Press Coverage",
        embeds: [{ title: `🟣 ${s.user_name} is live with ${project.name}`, url, description: `${s.title}\n${line}`, color: 0x9146ff, thumbnail: s.thumbnail_url ? { url: s.thumbnail_url.replace("{width}", "320").replace("{height}", "180") } : undefined }],
      });
    if (slack) await post(slack, { text: `🟣 *<${url}|${s.user_name}>* is live with ${project.name}: ${s.title} (${line})` });
  }
  if (discord || slack) log.info(`  alerts[${project.id}]: ${Math.min(streams.length, 10)} stream alert(s)`);
}
