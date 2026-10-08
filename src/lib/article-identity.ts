import { createHash } from "node:crypto";
import { normalizeArticleUrl } from "./rss/parse";
import type { ParsedFeedItem } from "./rss/types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function articleUrlIdentity(url: string): string | null {
  const normalized = normalizeArticleUrl(url);
  return normalized ? `url:${hash(normalized)}` : null;
}

export function itemIdentity(item: ParsedFeedItem): string {
  const urlKey = item.url ? articleUrlIdentity(item.url) : null;
  if (urlKey) return urlKey;
  // GUIDs without a permalink are only meaningful within their own feed.
  if (item.externalId) return `id:${hash(item.externalId)}`;
  return `hash:${hash(JSON.stringify([
    item.title, item.author, item.publishedAt, item.content ?? item.summary,
  ]))}`;
}
