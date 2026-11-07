// Relevance filtering + tagging. One Claude call per hit: is it really about the game,
// plus language, coverage type, sentiment and a one-line summary in EN and FR.
// Without ANTHROPIC_API_KEY a keyword heuristic is used instead.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import { guessLanguage, matchesTerms } from "./util.js";

function settings() {
  try { return JSON.parse(fs.readFileSync("config/settings.json", "utf8")); } catch { return {}; }
}
// Model chosen in the dashboard (config/settings.json); env var overrides it.
export const MODEL = process.env.COVERAGE_MODEL || settings().classifier_model || "claude-opus-5-5";
const EFFORT = process.env.COVERAGE_EFFORT || "low";

export const TYPES = ["review", "preview", "news", "feature", "interview", "guide", "listicle", "video", "stream", "social", "other"];
export const SENTIMENTS = ["positive", "neutral", "negative", "mixed"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "confidence", "reason", "language", "type", "sentiment", "summary_en", "summary_fr"],
  properties: {
    relevant: { type: "boolean", description: "True only if the item is substantively about THIS specific game." },
    confidence: { type: "number", description: "0 to 1" },
    reason: { type: "string", description: "Short justification (max 20 words)." },
    language: { type: "string", enum: ["fr", "en", "es", "de", "it", "pt", "ja", "other"] },
    type: { type: "string", enum: TYPES },
    sentiment: { type: "string", enum: SENTIMENTS, description: "Sentiment toward the game specifically." },
    summary_en: { type: "string", description: "One sentence, max 30 words, in English." },
    summary_fr: { type: "string", description: "Une phrase, max 30 mots, en français québécois neutre." },
  },
};

let client;
export function hasClaude() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function systemPrompt(project) {
  return [
    "You triage media coverage for a video game PR agency. For each item found by keyword monitoring, decide whether it is genuinely about the client's game, then tag it.",
    "",
    `Game: ${project.name}`,
    project.client ? `Developer/publisher: ${project.client}` : "",
    project.context ? `Context: ${project.context}` : "",
    `Search keywords: ${project.keywords.join(", ")}`,
    project.exclude_terms.length ? `Known false positives: ${project.exclude_terms.join(", ")}` : "",
    "",
    "Rules:",
    "- relevant=true when the game is the subject, or is meaningfully discussed (a mention in a roundup or 'games out this week' list counts; type=listicle).",
    "- relevant=false for unrelated products with a similar name, generic uses of the words, clones, spam, job postings, or SEO pages.",
    "- If the evidence is thin (title only, ambiguous), lower the confidence rather than guessing.",
    "- type: what kind of coverage this is. YouTube items are 'video' unless clearly a review/preview; Reddit/Bluesky posts are 'social'.",
    "- sentiment is toward the game, not the overall news.",
    "- Summaries describe what the piece says about the game, written for a client report.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function itemPrompt(hit) {
  return [
    `Source: ${hit.source}${hit.outlet ? ` / ${hit.outlet}` : ""}${hit.outlet_domain ? ` (${hit.outlet_domain})` : ""}`,
    hit.author ? `Author/channel: ${hit.author}` : "",
    hit.published_at ? `Published: ${hit.published_at}` : "",
    `URL: ${hit.url}`,
    `Title: ${hit.title || "(none)"}`,
    `Text: ${(hit.snippet || "(none)").slice(0, 2500)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function heuristicClassify(project, hit) {
  const text = `${hit.title || ""} ${hit.snippet || ""}`;
  const match = matchesTerms(text, project.required_terms);
  const excluded = project.exclude_terms.length && matchesTerms(text, project.exclude_terms);
  const type = { youtube: "video", reddit: "social", bluesky: "social", twitch: "stream" }[hit.source] ?? "news";
  return {
    relevant: match && !excluded,
    confidence: match ? 0.5 : 0.2,
    reason: match ? "keyword match (heuristic)" : "no keyword match (heuristic)",
    language: hit.lang || guessLanguage(text),
    type,
    sentiment: "neutral",
    summary_en: hit.title || "",
    summary_fr: hit.title || "",
    classified_by: "heuristic",
  };
}

/** Cheap pre-filter: search APIs (esp. YouTube) return fuzzy matches. Reject items that never mention the game. */
export function prefilterReject(project, hit) {
  const text = `${hit.title || ""} ${hit.snippet || ""} ${hit.author || ""}`;
  if (!matchesTerms(text, project.required_terms)) return "game name not present";
  if (project.exclude_terms.length && matchesTerms(`${hit.title} ${hit.snippet}`, project.exclude_terms) && !matchesTerms(hit.title || "", project.required_terms))
    return "matches an exclude term";
  return null;
}

export async function classifyWithClaude(project, hit) {
  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2048,
    // Re-runs a safety-declined request on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    system: [{ type: "text", text: systemPrompt(project), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: itemPrompt(hit) }],
  });
  if (response.stop_reason === "refusal") throw new Error(`refused (${response.stop_details?.category ?? "unknown"})`);
  if (response.stop_reason === "max_tokens") throw new Error("hit max_tokens");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text);
  return { ...out, classified_by: response.model || MODEL };
}

/** Classify a hit; falls back to the heuristic on any API error so polling never stalls. */
export async function classify(project, hit, log = console) {
  const reject = prefilterReject(project, hit);
  if (reject) {
    return { relevant: false, confidence: 0.9, reason: `prefilter: ${reject}`, language: hit.lang || guessLanguage(`${hit.title} ${hit.snippet}`), type: null, sentiment: null, summary_en: null, summary_fr: null, classified_by: "prefilter" };
  }
  if (!hasClaude()) return heuristicClassify(project, hit);
  try {
    return await classifyWithClaude(project, hit);
  } catch (err) {
    const kind = err instanceof Anthropic.RateLimitError ? "rate limited" : err instanceof Anthropic.AuthenticationError ? "auth error" : err instanceof Anthropic.APIError ? `API ${err.status}` : err.message;
    log.warn(`  classify: Claude failed for #${hit.id ?? "?"} (${kind}); using heuristic`);
    return heuristicClassify(project, hit);
  }
}

/** Map an array with bounded concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}
