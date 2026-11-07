# Game Press Coverage

A coverage tracker for game PR, built for MJR Comms clients. You use it entirely in your browser: no installs, no commands.

**Open the dashboard:** https://mjramos86.github.io/gamepresscoverage/

It finds coverage of your games in news sites (including Quebec French outlets), Google News, YouTube, Twitch, Reddit and Bluesky. An AI filter removes results that aren't really about your game and writes a one-line summary in French and English. It alerts you on Discord or Slack and makes branded, bilingual client reports.

## First-time setup (about 10 minutes, once)

Open the dashboard and follow the **Welcome** checklist:

1. **Connect your GitHub account.** Settings → follow the 4 steps to create a token and paste it. The token stays in your browser.
2. **Add your service keys** (Settings → Services & keys). Each service has a link explaining where to get its key. All are optional:
   - **Claude**: the AI filter and summaries
   - **YouTube** and **Twitch**: free
   - **Discord** or **Slack**: alerts
3. **Add your games** (Settings → Your games). Give each game its name, a short description, words it could be confused with, alert channel, and report colours/logo.
4. Click **Check for new coverage**. After that it runs by itself every 30 minutes, even with the page closed.

If the settings page shows a yellow note about the *default branch*, follow its link and set the default branch to `main`.

## Everyday use

| I want to… | Do this |
|---|---|
| See coverage | **Coverage** tab: pick the game and period at the top. Filter by kind, language, outlet tier or tone. EN/FR switches the summaries. |
| Remove something that isn't about the game | **✗ Not relevant** on the item |
| Check what the AI was unsure about | **To review** tab → ✓ Yes / ✗ No |
| Log TikTok, Instagram, X, print, radio/TV, podcasts | **+ Add coverage**: leave the summaries empty and the AI writes them |
| Change an outlet's tier (A/B/C) | The tier menu on any item, or Settings → News outlets |
| Look for new coverage right now | **↻ Check for new coverage** (takes 1–3 minutes, then the page updates) |
| Make a client report | **Create report** → choose dates and language → **Open report** → *Print → Save as PDF* |
| See Twitch streams | **Live streams** tab: streamer, duration, average and peak viewers, hours watched |

Anyone with the link can *view* the dashboard. Only people with a token can change things. The repository is public, so the collected coverage is public too; it's mostly published press coverage anyway.

## How it works (behind the scenes)

The GitHub repository is the whole system:

- **Settings** are JSON files on `main` in `config/`. The dashboard edits them for you.
- **A scheduled GitHub Actions job** (`.github/workflows/poll.yml`) collects new coverage, filters it with Claude, removes duplicates, and sends alerts. It runs:
  - every 30 minutes
  - whenever you change settings
  - when you click *Check for new coverage*
- **The collected data** (a SQLite database plus `data.json` for the dashboard) is stored on the `coverage-data` branch, overwritten each run so history stays small.
- **The dashboard** is a static page served by GitHub Pages from `main`.
- **Service keys** are stored as encrypted GitHub Actions secrets. They are encrypted in the browser before upload and can't be read back.

| Source | Notes |
|---|---|
| Curated outlets (`config/outlets.json`) | RSS feeds, checked hourly. Feed URLs were compiled without testing; fix any that fail (see *Behind the scenes → Status of each source*). |
| Google News | French and English Canadian editions, every 2 h. Finds outlets with no feed (La Presse, Le Devoir, Radio-Canada…). |
| YouTube | Every 6 h by default (adjustable per game). Stays under the free daily quota. |
| Twitch | Every run. The game needs a Twitch category. Stream durations are accurate to about ±30 min. |
| Reddit, Bluesky | Every 2 h. |
| TikTok, Instagram, X, print, broadcast | No open search exists, so log these with **+ Add coverage**. |

**AI cost:** one short request per new result. Settings → AI filter lets you pick the model. Claude Haiku 5.5 costs fractions of a cent per result; Opus 5.5 (the default) is the most accurate for very generic names. Results that never mention the game are dropped for free before any AI call.

## For developers

Requires Node 22.13+ (uses the built-in `node:sqlite`).

Install dependencies:

```bash
npm install
```

Run the tests:

```bash
npm test
```

Preview locally with sample data (read-only preview, opens on http://127.0.0.1:8787):

```bash
npm run demo && npm run serve:demo
```

Run one polling pass locally (keys go in `.env`; see `.env.example`):

```bash
npm run poll -- --force
```

Generate a report from the command line:

```bash
npm run report -- --project solitaire-tower --from 2026-10-01 --to 2026-10-31
```

```
index.html          dashboard page (served by GitHub Pages)
web/                dashboard code: app.js, github.js (GitHub API + secret encryption), report-core.js (shared report renderer), vendor/libsodium
config/             projects.json, outlets.json, edits.json (your corrections + manual entries), settings.json
src/collectors/     rss, googlenews, youtube, twitch, reddit, bluesky
src/lib/            db (node:sqlite), classify (Claude + heuristic), dedupe, edits, alerts, util
src/poll.js         apply dashboard edits → collect → store → dedupe → classify → alert
src/export.js       builds data.json for the dashboard
test/               node:test tests
```
