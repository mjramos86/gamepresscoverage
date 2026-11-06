# Game Press Coverage

A self-hosted coverage tracker for game PR, built for MJR Comms clients. It monitors web press, YouTube, Twitch, Reddit and Bluesky for each game. Claude filters out false positives and tags each hit. It sends Discord/Slack alerts, shows everything in a browser dashboard, and generates bilingual (FR/EN) client-branded reports, which covers the CoverageBook use case.

## What it does

| Channel | How | Notes |
|---|---|---|
| **Curated outlets** | RSS feeds in `config/outlets.json` (Quebec francophone, France, international) | Fetched once per run, pre-filtered by game name before any LLM call. You control the list. |
| **Google News** | RSS search per keyword, `fr-CA` and `en-CA` editions | Catches outlets with no feed (La Presse, Le Devoir, Radio-Canada…). Tiers applied by domain. |
| **YouTube** | Data API v3 `search.list` + `videos.list` + `channels.list` | Views, likes, comments, channel subscribers. A daily unit budget guard keeps you under the free 10,000-unit quota (~100 searches). Polled every `every_hours` (default 6). |
| **Twitch** | Helix `streams?game_id=` polled every run | Logs each stream session: streamer, start, duration, peak and average viewers, followers, estimated hours watched. Needs a Twitch category for the game. |
| **Reddit** | Search API (OAuth app-only if configured, public JSON otherwise) | Score, comments, subreddit size. |
| **Bluesky** | `app.bsky.feed.searchPosts` (authenticated with an app password if configured) | Likes, replies. |
| **TikTok, Instagram, X, print, radio/TV, podcasts** | **Manual logging** form in the dashboard | No practical open search exists. Claude writes the bilingual summary if you leave it blank. |

**The smart parts**

- **Relevance filtering with Claude.** Each new hit gets one structured-output call: is it really about *this* game, with confidence and a reason. The same call tags language, coverage type (review, preview, news, feature, interview, listicle, video…), sentiment toward the game, and writes a one-line summary in **English and French**. Project `context` and `exclude_terms` in the config handle generic names like "Solitaire Tower".
  - A free pre-filter rejects search results that never mention the game, so you don't pay for fuzzy YouTube matches.
  - Without `ANTHROPIC_API_KEY`, a keyword heuristic is used, so everything still runs.
  - The **Review queue** tab shows rejected and low-confidence items. Your overrides are final and never changed by later polls.
- **Deduplication.** Identical URLs are merged after canonicalisation (tracking params, `www`/`amp`, YouTube short links). Syndicated or wire copies, and Google News copies of RSS items, are matched by title similarity within 5 days. Copies are grouped under the original ("+2 syndications") and inherit its classification at no extra LLM cost.
- **Metrics.** YouTube views and subscribers and Twitch viewer stats come from the APIs. Outlet reach uses an honest manual **A/B/C tier** per domain (in `config/outlets.json`, editable per hit in the dashboard).

## Quick start

Requires **Node 22.13+** (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
```

```bash
npm run demo && npm run serve:demo
```

Open http://127.0.0.1:8787. The demo uses sample data in `data/demo.db` and needs no API keys.

For real data:

```bash
cp .env.example .env    # then fill in the keys you have; every source is optional
```

```bash
npm run check-feeds     # validate the RSS URLs in config/outlets.json
```

```bash
npm run poll -- --force # one polling pass (ignores per-source intervals)
```

```bash
npm run serve           # dashboard on http://127.0.0.1:8787
```

## Configuration

**`config/projects.json`**: one entry per client or game:

- `keywords`: search queries. Use quotes for exact phrases.
- `required_terms`: what must appear for an item to pass the cheap pre-filter. Defaults to the keywords.
- `exclude_terms`, `context`: help Claude separate your game from look-alikes.
- `sources`: per-source toggles. Examples: `youtube.queries` and `every_hours`, `twitch.game_id` (resolved from `game_name` automatically if empty), `twitch.min_viewers`.
- `alerts`: the **name** of the env var holding the Discord/Slack webhook (never the URL itself), `min_tier` for web alerts, and `notify_streams`.
- `branding`: primary/accent colours, client and agency logo URLs, and the default report language.

**`config/outlets.json`**: curated outlets with `domain`, optional `feed`, `lang`, `region` and `tier`. Domains without a feed still give Google News and manual hits their tier. **Feed URLs were compiled without network access, so run `npm run check-feeds` and fix any that fail.**

**Environment** (see `.env.example`):

- `ANTHROPIC_API_KEY`, `COVERAGE_MODEL` (default `claude-opus-5-5`), `COVERAGE_EFFORT` (default `low`)
- `YOUTUBE_API_KEY`, `TWITCH_CLIENT_ID`/`SECRET`, optional Reddit/Bluesky credentials
- `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` as global fallbacks
- `DASHBOARD_TOKEN` to protect write endpoints, `HOST`/`PORT`

### Claude cost

One short call per *new, pre-filtered* hit, using low effort and a cached system prompt per project. The default model is Claude Opus 5.5 ($4 / $20 per million tokens). For high-volume monitoring, `COVERAGE_MODEL=claude-haiku-5-5` ($0.10 / $0.50) is dramatically cheaper and generally fine for triage, so try it on your review queue. Requests opt into Anthropic's server-side refusal fallback (`fallbacks: "default"`). Any API error falls back to the heuristic, so polling never stalls.

## Dashboard

- KPIs (pieces, Tier A, unique outlets, syndications, YouTube views, Twitch streams, hours watched, peak viewers, % positive, % French) and coverage per day.
- Coverage list with search and filters (medium, source, tier, language, type, sentiment), syndications grouped, and EN/FR summaries.
- Per-hit actions: relevant / not relevant, tier, sentiment, delete (manual entries only).
- **Twitch streams** table (live indicator, duration, avg/peak, hours watched).
- **Review queue**, a **Log manually** form, and **Sources** status (last run and errors per source).
- **Poll now** and **Report** buttons.

The server binds to `127.0.0.1` by default. If you expose it (`HOST=0.0.0.0`), set `DASHBOARD_TOKEN`.

`npm run export` builds a **read-only static** version in `site/`: the dashboard, `data.json` (confirmed coverage only) and last-30-day reports. You can host it anywhere.

## Reports

```bash
npm run report -- --project solitaire-tower --from 2026-10-01 --to 2026-10-31 --lang fr
```

This produces a single self-contained HTML file in `reports/` with:

- client branding and an FR/EN toggle
- KPI tiles, sentiment and language bars, and highlights
- web press (with syndications listed), video, live streams, social, and print/broadcast sections
- a methodology note

Use the browser's **Print → Save as PDF** for a PDF; print styles are included. The dashboard's **Report** button opens the same report for the selected period.

## Running it on a schedule (GitHub Actions)

`.github/workflows/poll.yml` runs every 30 minutes. Each source enforces its own minimum interval: Twitch every run, RSS hourly, Google News/Reddit/Bluesky every 2 h, YouTube every 6 h.

1. Add the keys as **repository secrets** (`ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `DISCORD_WEBHOOK_URL`…). For per-project webhook env names, add a matching line to the workflow's `env:` block.
2. The SQLite DB is kept on a `coverage-data` branch as a **single force-pushed commit**, so repo history doesn't grow.
3. Each run uploads the static dashboard as a private build artifact. To publish it on GitHub Pages, set the repo variable `PUBLISH_DASHBOARD=true` and enable Pages with the "GitHub Actions" source. **Pages sites are public**, so think about client confidentiality first.

Twitch session durations are only as precise as the polling interval: ±30 min on the Actions cron, which is often delayed by a few minutes under load. For tighter stream tracking, run `npm run poll` from a cron job on any always-on machine, or move polling to Cloudflare Workers.

## Project layout

```
config/            projects.json (clients/games), outlets.json (curated outlets + tiers)
src/collectors/    rss, googlenews, youtube, twitch, reddit, bluesky, feed parser
src/lib/           db (node:sqlite), classify (Claude + heuristic), dedupe, alerts, util, config
src/poll.js        collect → store → dedupe → classify → alert
src/report.js      bilingual branded HTML report
src/server.js      dashboard server + JSON API
src/export.js      static read-only export
web/               dashboard UI (vanilla JS, no build step)
test/              node:test unit + pipeline tests
```

## Roadmap ideas

- Supabase/Postgres adapter for multi-user access (the DB layer is a single module).
- Outlet tier editor in the dashboard, writing back to `config/outlets.json`.
- Twitch VOD lookups to backfill streams that started and ended between polls.
- Weekly digest email or Slack summary, and scheduled monthly reports.
- Full-text fetch of articles for better classification of thin RSS snippets.
