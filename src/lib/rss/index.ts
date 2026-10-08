import { fetchFeedXml } from "./fetch";
import { parseFeed } from "./parse";
import type { ParsedFeed } from "./types";

export { parseFeed, normalizeArticleUrl } from "./parse";
export { RssError } from "./types";
export type { ParsedFeed, ParsedFeedItem, FeedItemIdKind, RssErrorCode } from "./types";

export async function previewFeed(url: string): Promise<ParsedFeed> {
  const response = await fetchFeedXml(url);
  return parseFeed(response.xml, response.url);
}
