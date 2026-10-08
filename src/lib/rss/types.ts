export type FeedItemIdKind = "guid" | "url" | "hash";

export interface ParsedFeedItem {
  /** Stable within a feed: publisher ID, normalized article URL, or content hash. */
  externalId: string;
  idKind: FeedItemIdKind;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  /** Plain text only. Never render any feed field using dangerouslySetInnerHTML. */
  summary: string | null;
  /** Full plain text supplied by the feed, falling back to its description. */
  content: string | null;
  contentKind?: "rss_content" | "rss_description";
  imageUrl: string | null;
}

export interface ParsedFeed {
  /** Final feed URL after validated redirects. */
  url: string;
  title: string;
  description: string | null;
  siteUrl: string | null;
  language: string | null;
  items: ParsedFeedItem[];
}

export type RssErrorCode =
  | "INVALID_URL"
  | "UNSAFE_URL"
  | "DNS_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "TOO_MANY_REDIRECTS"
  | "TOO_LARGE"
  | "ACCESS_CHALLENGE"
  | "INVALID_XML"
  | "NOT_A_FEED";

export class RssError extends Error {
  constructor(
    public readonly code: RssErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "RssError";
  }
}
