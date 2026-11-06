// Seeds a demo database with realistic sample coverage so the dashboard and reports can be explored
// without any API keys. Run: npm run demo && npm run serve:demo
import { openDb, insertHit, updateHit } from "./lib/db.js";
import { canonicalUrl } from "./lib/util.js";
import { dedupeNewHits } from "./lib/dedupe.js";

const P = "solitaire-tower";
const ago = (d, h = 0) => new Date(Date.now() - d * 86400_000 - h * 3600_000).toISOString();

const HITS = [
  { source: "rss", outlet: "Pèse sur Start", outlet_domain: "pesesurstart.com", tier: "B", lang: "fr", type: "review", sentiment: "positive", d: 2,
    title: "Critique de Solitaire Tower : le roguelite de cartes qui nous a volé nos soirées", url: "https://pesesurstart.com/critique-solitaire-tower/",
    summary_fr: "Critique enthousiaste qui salue la boucle roguelite addictive et la direction artistique chaleureuse.", summary_en: "Enthusiastic review praising the addictive roguelite loop and warm art direction." },
  { source: "google_news", outlet: "La Presse", outlet_domain: "lapresse.ca", tier: "A", lang: "fr", type: "feature", sentiment: "positive", d: 4,
    title: "Un studio montréalais mise sur le solitaire pour conquérir le mobile - La Presse", url: "https://www.lapresse.ca/affaires/techno/2026-11-02/studio-montrealais-solitaire.php",
    summary_fr: "Portrait du studio montréalais et de son pari sur un jeu de solitaire réinventé pour mobile.", summary_en: "Profile of the Montréal studio and its bet on a reinvented solitaire game for mobile." },
  { source: "google_news", outlet: "Le Soleil", outlet_domain: "lesoleil.com", tier: "B", lang: "fr", type: "feature", sentiment: "positive", d: 4, h: -3,
    title: "Un studio montréalais mise sur le solitaire pour conquérir le mobile - Le Soleil", url: "https://www.lesoleil.com/techno/2026/11/02/un-studio-montrealais-mise-sur-le-solitaire",
    summary_fr: "Reprise du portrait de La Presse.", summary_en: "Syndicated copy of the La Presse profile." },
  { source: "google_news", outlet: "Radio-Canada", outlet_domain: "ici.radio-canada.ca", tier: "A", lang: "fr", type: "interview", sentiment: "neutral", d: 9,
    title: "Les jeux vidéo québécois à l'heure du mobile : entrevue avec l'équipe de Solitaire Tower", url: "https://ici.radio-canada.ca/nouvelle/2100001/jeux-video-quebec-mobile",
    summary_fr: "Entrevue sur les défis des studios québécois sur mobile, avec Solitaire Tower en exemple.", summary_en: "Interview on Québec studios' mobile challenges, featuring Solitaire Tower as a case study." },
  { source: "rss", outlet: "Pocket Gamer", outlet_domain: "pocketgamer.com", tier: "B", lang: "en", type: "news", sentiment: "positive", d: 12,
    title: "Solitaire Tower is a cozy card roguelite out now on iOS and Android", url: "https://www.pocketgamer.com/solitaire-tower/out-now/",
    summary_en: "Launch news highlighting the cozy tone and free-to-start model.", summary_fr: "Annonce de lancement qui souligne le ton chaleureux et le modèle gratuit au départ." },
  { source: "rss", outlet: "TouchArcade", outlet_domain: "toucharcade.com", tier: "B", lang: "en", type: "review", sentiment: "mixed", d: 7,
    title: "'Solitaire Tower' Review – Stacking the Deck, Mostly in Your Favor", url: "https://toucharcade.com/2026/10/30/solitaire-tower-review/",
    summary_en: "Mostly positive review; praises depth but criticises late-game difficulty spikes.", summary_fr: "Critique surtout positive; salue la profondeur mais critique des pics de difficulté en fin de partie." },
  { source: "rss", outlet: "Rock Paper Shotgun", outlet_domain: "rockpapershotgun.com", tier: "A", lang: "en", type: "listicle", sentiment: "positive", d: 5,
    title: "The best new mobile games this week, including Solitaire Tower", url: "https://www.rockpapershotgun.com/best-new-mobile-games-this-week",
    summary_en: "Weekly roundup naming Solitaire Tower among the best new releases.", summary_fr: "Sélection hebdomadaire qui place Solitaire Tower parmi les meilleures nouveautés." },
  { source: "google_news", outlet: "Montreal Gazette", outlet_domain: "montrealgazette.com", tier: "A", lang: "en", type: "news", sentiment: "positive", d: 3,
    title: "Montreal indie's Solitaire Tower climbs App Store charts", url: "https://montrealgazette.com/business/local-business/solitaire-tower-app-store",
    summary_en: "Reports the game's climb in App Store charts in its first week.", summary_fr: "Rapporte la montée du jeu dans les palmarès de l'App Store dès sa première semaine." },
  { source: "youtube", medium: "video", outlet: "Gamerz Québec", author: "Gamerz Québec", outlet_domain: "youtube.com", lang: "fr", type: "video", sentiment: "positive", d: 6, views: 48200, likes: 2100, comments: 186, audience: 312000,
    title: "J'ai joué à SOLITAIRE TOWER pendant 10 heures (et j'ai pas regretté)", url: "https://www.youtube.com/watch?v=demo0000001", thumbnail: "",
    summary_fr: "Vidéo découverte enthousiaste après 10 heures de jeu.", summary_en: "Enthusiastic first-impressions video after 10 hours of play." },
  { source: "youtube", medium: "video", outlet: "Mobile Gaming Hub", author: "Mobile Gaming Hub", outlet_domain: "youtube.com", lang: "en", type: "review", sentiment: "positive", d: 8, views: 126500, likes: 5400, comments: 410, audience: 1450000,
    title: "Solitaire Tower Review - Is This The Best Card Roguelite on Mobile?", url: "https://www.youtube.com/watch?v=demo0000002",
    summary_en: "Video review calling it one of the best card roguelites on mobile.", summary_fr: "Critique vidéo qui le qualifie de l'un des meilleurs roguelites de cartes sur mobile." },
  { source: "reddit", medium: "social", platform: "reddit", outlet: "r/iosgaming", author: "u/cardsharp", outlet_domain: "reddit.com", lang: "en", type: "social", sentiment: "positive", d: 10, likes: 842, comments: 133, audience: 380000,
    title: "Solitaire Tower is the first F2P game in years that doesn't feel predatory", url: "https://www.reddit.com/r/iosgaming/comments/demo01/solitaire_tower/",
    summary_en: "Popular thread praising the fair monetisation.", summary_fr: "Fil populaire qui salue une monétisation équitable." },
  { source: "bluesky", medium: "social", platform: "bluesky", outlet: "Bluesky", author: "Indie Games Daily (@indiegamesdaily.bsky.social)", outlet_domain: "bsky.app", lang: "en", type: "social", sentiment: "positive", d: 1, likes: 214, comments: 12,
    title: "Solitaire Tower just dropped and it's absolutely gorgeous 🃏✨", url: "https://bsky.app/profile/indiegamesdaily.bsky.social/post/demo01",
    summary_en: "Launch-day post praising the visuals.", summary_fr: "Publication du jour du lancement qui salue les visuels." },
  { source: "manual", medium: "social", platform: "tiktok", outlet: "TikTok", author: "@cozygamerjules", lang: "fr", type: "social", sentiment: "positive", d: 3, views: 310000, likes: 41000, comments: 920, audience: 228000,
    title: "POV : tu découvres Solitaire Tower à 2h du matin", url: "https://www.tiktok.com/@cozygamerjules/video/demo01",
    summary_fr: "TikTok humoristique devenu viral sur l'aspect addictif du jeu.", summary_en: "Humorous TikTok that went viral about the game's addictiveness." },
  { source: "manual", medium: "broadcast", platform: "radio", outlet: "98.5 Montréal", author: "Segment techno", tier: "A", lang: "fr", type: "interview", sentiment: "positive", d: 11, audience: 900000,
    title: "Chronique techno : Solitaire Tower, le petit jeu montréalais qui fait jaser", url: "manual:985-chronique-techno",
    summary_fr: "Chronique radio de 6 minutes présentant le jeu et le studio.", summary_en: "Six-minute radio segment presenting the game and the studio." },
  // Irrelevant hits the filter rejected (shown in the review queue)
  { source: "google_news", outlet: "AppAdvice", outlet_domain: "appadvice.com", lang: "en", type: "other", d: 6, relevant: 0, confidence: 0.9, reason: "About a different 'Tower Solitaire' app by another developer.",
    title: "Tower Solitaire Classic gets new daily challenges", url: "https://appadvice.com/post/tower-solitaire-classic-daily/" },
  { source: "youtube", medium: "video", outlet: "CardGames4All", author: "CardGames4All", outlet_domain: "youtube.com", lang: "en", type: "video", d: 5, relevant: 1, confidence: 0.55, reason: "Mentions the game in a list but focus is unclear.", views: 1800, audience: 9000,
    title: "Top 10 Solitaire games 2026 (Solitaire Tower, Balatro and more)", url: "https://www.youtube.com/watch?v=demo0000003", sentiment: "neutral",
    summary_en: "Top-10 list that briefly includes Solitaire Tower.", summary_fr: "Top 10 qui inclut brièvement Solitaire Tower." },
];

const STREAMS = [
  { id: "s1", login: "ludo_mtl", name: "Ludo_MTL", lang: "fr", d: 2, hours: 3.5, peak: 412, avg: 280, followers: 18400, title: "Solitaire Tower jusqu'au sommet 🃏 !drops" },
  { id: "s2", login: "cozycardqueen", name: "CozyCardQueen", lang: "en", d: 5, hours: 2.2, peak: 1240, avg: 860, followers: 96000, title: "First look: Solitaire Tower (sponsored)" },
  { id: "s3", login: "petitpixel", name: "PetitPixel", lang: "fr", d: 9, hours: 1.4, peak: 75, avg: 51, followers: 2300, title: "découverte Solitaire Tower" },
  { id: "s4", login: "speedydeck", name: "SpeedyDeck", lang: "en", d: 0, hours: 0.8, peak: 190, avg: 150, followers: 7600, title: "Solitaire Tower any% attempts", live: true },
];

export function seedDemo() {
  const db = openDb();
  if (db.prepare("SELECT COUNT(*) n FROM hits").get().n > 0) {
    console.log("Database already has data; demo seed skipped (delete the demo DB to reseed).");
    return;
  }
  const ids = [];
  for (const h of HITS) {
    const id = insertHit({
      project_id: P, source: h.source, medium: h.medium || "web", platform: h.platform, url: h.url,
      canonical_url: h.url.startsWith("http") ? canonicalUrl(h.url) : h.url, title: h.title, snippet: h.summary_en || "",
      author: h.author, outlet: h.outlet, outlet_domain: h.outlet_domain, tier: h.tier ?? null,
      published_at: ago(h.d, h.h || 0), discovered_at: ago(h.d, (h.h || 0) - 1), lang: h.lang, type: h.type, sentiment: h.sentiment ?? null,
      relevant: h.relevant ?? 1, relevance_confidence: h.confidence ?? 0.95, relevance_reason: h.reason ?? "About the game.",
      classified_by: h.source === "manual" ? "manual" : "demo", summary_en: h.summary_en ?? null, summary_fr: h.summary_fr ?? null,
      views: h.views ?? null, likes: h.likes ?? null, comments: h.comments ?? null, audience: h.audience ?? null, thumbnail: h.thumbnail || null,
      manual_override: h.source === "manual" ? 1 : 0,
    });
    if (id) ids.push(id);
  }
  const dups = dedupeNewHits(P, ids);
  for (const id of dups) updateHit(id, { classified_by: "duplicate" });
  for (const s of STREAMS) {
    const started = ago(s.d, s.hours + 1);
    const last = new Date(Date.parse(started) + s.hours * 3600_000).toISOString();
    db.prepare(
      `INSERT INTO streams (stream_id, project_id, user_login, user_name, title, language, started_at, last_seen_at, ended_at, peak_viewers, viewer_sum, samples, followers)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(s.id, P, s.login, s.name, s.title, s.lang, started, last, s.live ? null : last, s.peak, Math.round(s.avg * 10), 10, s.followers);
  }
  console.log(`Demo data seeded: ${ids.length} hits (${dups.length} merged as syndication), ${STREAMS.length} streams.`);
}
