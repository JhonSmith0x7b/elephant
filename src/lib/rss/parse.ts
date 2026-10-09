import { articleLinkUrl, articlePlainText, storedMarkdownLink } from "../article-links";
import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { Parser as HtmlParser } from "htmlparser2";
import { MAX_FEED_BYTES, validateFeedUrl } from "./fetch";
import { RssError, type ParsedFeed, type ParsedFeedItem } from "./types";

const MAX_ITEMS = 150;
type Node = Record<string, unknown>;

function object(value: unknown): Node {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Node : {};
}

function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function field(value: unknown, name: string): unknown {
  const node = object(value);
  if (node[name] !== undefined) return node[name];
  const key = Object.keys(node).find((key) => key.endsWith(`:${name}`));
  return key ? node[key] : undefined;
}

function string(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(string).join(" ");
  // Atom XHTML constructs are XML nodes; only return their text, not their markup.
  return Object.entries(object(value))
    .filter(([key]) => !key.startsWith("@"))
    .map(([, child]) => string(child)).join(" ");
}

function safeHttpUrl(value: unknown, base: string): string | null {
  const raw = string(value).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    validateFeedUrl(url.href);
    return url.href;
  } catch { return null; }
}

/** For identity comparisons only; the original article URL is kept separately. */
export function normalizeArticleUrl(input: string, base = input): string | null {
  const safe = safeHttpUrl(input, base);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  // 36kr's official feeds and RSSHub use these two hosts for the same article.
  // Keep this publisher-specific: www and arbitrary query keys are not aliases
  // on every website, and removing them globally could merge different pages.
  if (["36kr.com", "www.36kr.com"].includes(url.hostname)
    && /^\/(?:p|newsflashes)\/\d+\/?$/.test(url.pathname)) {
    url.hostname = "www.36kr.com";
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/$/, "");
    if (url.searchParams.get("f") === "rss") url.searchParams.delete("f");
  }
  url.searchParams.sort();
  return url.href;
}

function readHtml(value: unknown, base: string): { text: string; body: string; imageUrl: string | null } {
  const parts: string[] = [];
  const bodyParts: string[] = [];
  let anchor: { start: number; href: string } | null = null;
  const append = (text: string) => { parts.push(text); bodyParts.push(text); };
  let ignoredDepth = 0;
  let imageUrl: string | null = null;
  const ignoredTags = new Set(["script", "style", "noscript", "iframe", "svg", "template"]);
  const blockTags = new Set(["p", "div", "br", "li", "blockquote", "h1", "h2", "h3", "h4", "section"]);
  const parser = new HtmlParser({
    onopentag(name, attributes) {
      if (ignoredTags.has(name)) ignoredDepth += 1;
      if (ignoredDepth) return;
      if (blockTags.has(name)) append("\n");
      if (name === "a") {
        const href = articleLinkUrl(attributes.href || "", base);
        if (href) anchor = { start: bodyParts.length, href };
      }
      if (name === "img" && !imageUrl) {
        imageUrl = safeHttpUrl(attributes["data-src"] || attributes.src, base);
      }
    },
    ontext(text) { if (!ignoredDepth) append(text); },
    onclosetag(name) {
      if (ignoredTags.has(name)) ignoredDepth = Math.max(0, ignoredDepth - 1);
      if (!ignoredDepth && name === "a" && anchor) {
        const label = bodyParts.splice(anchor.start).join("");
        bodyParts.push(storedMarkdownLink(label, anchor.href));
        anchor = null;
      }
      if (!ignoredDepth && blockTags.has(name)) append("\n");
    },
  }, { decodeEntities: true });
  parser.end(string(value));
  const clean = (text: string) => text.replace(/[\t\r\f\v \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: articlePlainText(clean(parts.join("")), base),
    body: clean(bodyParts.join("")),
    imageUrl,
  };
}

function plain(value: unknown, base: string, limit: number): string | null {
  return readHtml(value, base).text.slice(0, limit) || null;
}

function date(value: unknown): string | null {
  const raw = string(value).trim();
  // Date.parse accepts odd values such as "0"; those are not publication dates.
  if (!raw || !/\d{4}/.test(raw)) return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function link(value: unknown, base: string): string | null {
  const links = array(field(value, "link"));
  for (const candidate of links) {
    if (typeof candidate === "string") {
      const url = safeHttpUrl(candidate, base);
      if (url) return url;
    }
    const node = object(candidate);
    const rel = string(node["@rel"]);
    if (!rel || rel === "alternate") {
      const url = safeHttpUrl(node["@href"], base);
      if (url) return url;
    }
  }
  return null;
}

function author(value: unknown, base: string): string | null {
  const creator = field(value, "creator");
  if (creator) return plain(creator, base, 300);
  return array(field(value, "author")).map((person) =>
    plain(field(person, "name") ?? person, base, 300),
  ).filter(Boolean).join(", ").slice(0, 300) || null;
}

function mediaImage(item: unknown, base: string): string | null {
  const node = object(item);
  const group = object(field(item, "group"));
  const thumbnails = [...array(field(item, "thumbnail")), ...array(field(group, "thumbnail"))];
  for (const thumbnail of thumbnails) {
    const src = safeHttpUrl(object(thumbnail)["@url"], base);
    if (src) return src;
  }
  const media = [...array(node["media:content"]), ...array(group["media:content"]), ...array(field(item, "enclosure"))];
  for (const child of media) {
    const entry = object(child);
    const src = safeHttpUrl(entry["@url"], base);
    if (src && (string(entry["@type"]).startsWith("image/") || entry["@medium"] === "image" || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(src))) return src;
  }
  return null;
}

function atomContent(value: unknown): unknown {
  const node = object(value);
  const raw = typeof value === "string" ? value : string(node["#text"]);
  if (node["@type"] === "xhtml") return raw;
  // A stopped content node preserves XML source. Decode its XML text/CDATA once;
  // the HTML parser will then handle HTML entities and markup in reading order.
  return new XMLParser({ parseTagValue: false, trimValues: false }).parse(`<value>${raw}</value>`).value;
}

function parseItem(item: unknown, feed: unknown, feedUrl: string, atom: boolean): ParsedFeedItem {
  const itemBase = safeHttpUrl(object(item)["@xml:base"], feedUrl) ?? feedUrl;
  const guidValue = string(field(item, atom ? "id" : "guid")).trim();
  const guid = guidValue.slice(0, 2048);
  const guidNode = object(field(item, "guid"));
  const guidUrl = !atom && guidNode["@isPermaLink"] !== "false" && /^https?:\/\//i.test(guidValue)
    ? safeHttpUrl(guidValue, itemBase) : null;
  const url = link(item, itemBase) ?? guidUrl;
  const base = url ?? itemBase;
  const title = plain(field(item, "title"), base, 500) ?? "未命名文章";
  const contentValue = atom ? atomContent(field(item, "content")) : field(item, "encoded");
  const summaryValue = field(item, atom ? "summary" : "description");
  const content = readHtml(contentValue, base);
  const summary = readHtml(summaryValue, base);
  const publishedAt = date(field(item, atom ? "published" : "pubDate") ?? (!atom ? field(item, "date") : undefined));
  const normalizedUrl = url ? normalizeArticleUrl(url) : null;
  const hash = createHash("sha256").update(JSON.stringify([title, publishedAt, summary.text, content.text])).digest("hex");
  return {
    externalId: guid || normalizedUrl || hash,
    idKind: guid ? "guid" : normalizedUrl ? "url" : "hash",
    url,
    title,
    author: author(item, base) ?? (atom ? author(feed, base) : null),
    publishedAt,
    updatedAt: date(field(item, "updated") ?? field(item, "modified")),
    summary: (summary.text || content.text).slice(0, 1200) || null,
    content: content.body || summary.body || null,
    contentKind: content.text ? "rss_content" : "rss_description",
    imageUrl: mediaImage(item, base) ?? content.imageUrl ?? summary.imageUrl,
  };
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  if (Buffer.byteLength(xml, "utf8") > MAX_FEED_BYTES) throw new RssError("TOO_LARGE", "订阅内容超过 2 MB，请使用内容较少的订阅入口。");
  // Some feed endpoints respond HTTP 200 with a browser verification page.
  // Recognize the HTML document before treating its DOCTYPE as an XML error.
  const start = xml.replace(/^(?:\s|<\?xml\b[\s\S]*?\?>|<!--[\s\S]*?-->)+/i, "");
  if (/^(?:<!DOCTYPE\s+html(?:\s|>)|<html(?:\s|>))/i.test(start)) {
    const text = readHtml(xml, feedUrl).text;
    if (/正在进行安全检测|checking your browser|verify (?:that )?you are human/i.test(text)) {
      throw new RssError("ACCESS_CHALLENGE", "订阅网站返回了安全验证页面，后台目前未取得 RSS 内容。地址可能仍然有效，请稍后重试或使用来源提供的其他订阅入口。", 502);
    }
    throw new RssError("NOT_A_FEED", "该地址当前返回的是 HTML 网页，而不是 RSS 或 Atom 内容。请检查订阅地址，或稍后重试。");
  }
  // RSS/Atom do not require document type declarations. Reject custom entities entirely.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RssError("INVALID_XML", "该订阅包含不支持的 XML 文档类型或实体声明。");
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new RssError("INVALID_XML", "该地址返回的 XML 格式不完整或有误，请检查 RSS 订阅地址。");
  let document: Node;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      textNodeName: "#text",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: true,
      ignoreDeclaration: true,
      stopNodes: ["*.content"],
    }).parse(xml) as Node;
  } catch { throw new RssError("INVALID_XML", "无法解析该订阅的 XML 内容。"); }

  const atomFeed = field(document, "feed");
  const rss = field(document, "rss");
  const rdf = field(document, "RDF");
  const feed = atomFeed ?? field(rss ?? rdf, "channel");
  if (!feed || typeof feed !== "object") throw new RssError("NOT_A_FEED", "该地址不是 RSS 或 Atom 订阅，请填写订阅链接，而不是网站首页。");
  const atom = atomFeed !== undefined;
  const base = safeHttpUrl(object(feed)["@xml:base"], feedUrl) ?? feedUrl;
  const items = array(field(atom ? feed : (rdf ?? feed), atom ? "entry" : "item"));
  return {
    url: feedUrl,
    title: plain(field(feed, "title"), base, 300) ?? new URL(feedUrl).hostname,
    description: plain(field(feed, atom ? "subtitle" : "description"), base, 1200),
    siteUrl: link(feed, base),
    language: string(field(feed, "language") ?? object(feed)["@xml:lang"]).trim().slice(0, 50) || null,
    items: items.slice(0, MAX_ITEMS).map((item) => parseItem(item, feed, base, atom)),
  };
}
