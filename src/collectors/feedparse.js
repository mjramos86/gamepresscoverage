// RSS 2.0 / Atom / RDF parser on top of fast-xml-parser.
import { XMLParser } from "fast-xml-parser";
import { stripHtml, isoOrNull } from "../lib/util.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry", "link", "category"].includes(name),
});

const text = (v) => (v == null ? "" : typeof v === "object" ? (v["#text"] ?? "") : String(v));

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const channel = doc.rss?.channel ?? doc["rdf:RDF"]?.channel;
  const rawItems = doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item ?? doc.feed?.entry ?? [];
  const feedTitle = text(channel?.title ?? doc.feed?.title);
  const items = rawItems.map((it) => {
    let link = "";
    if (Array.isArray(it.link)) {
      const alt = it.link.find((l) => typeof l === "object" && (!l["@_rel"] || l["@_rel"] === "alternate")) ?? it.link[0];
      link = typeof alt === "object" ? alt["@_href"] ?? text(alt) : String(alt);
    } else if (it.link) link = text(it.link);
    if (!link && it.guid) link = text(it.guid);
    const source = it.source; // Google News: <source url="https://outlet.com">Outlet</source>
    return {
      title: stripHtml(text(it.title)),
      link: link.trim(),
      description: stripHtml(text(it.description ?? it.summary ?? it["content:encoded"] ?? it.content)).slice(0, 1000),
      published: isoOrNull(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
      author: stripHtml(text(it["dc:creator"] ?? it.author?.name ?? it.author)),
      sourceName: source ? text(source) : "",
      sourceUrl: source && typeof source === "object" ? source["@_url"] ?? "" : "",
      thumbnail: it["media:content"]?.["@_url"] ?? it["media:thumbnail"]?.["@_url"] ?? it.enclosure?.["@_url"] ?? "",
    };
  });
  return { title: feedTitle, items };
}
