import type { ParsedFeedItem } from "./rss/types";

export type SourceChannel = string;
export type ContentKind = "rss_content" | "rss_description";

export interface ChannelRecord {
  id: string;
  name: string;
}

export interface SourceRecord {
  id: string;
  name: string;
  feedUrl: string;
  siteUrl: string | null;
  channel: SourceChannel;
  channelName: string;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface LibrarySource extends SourceRecord {
  articleCount: number;
}

export interface LibraryArticle {
  id: string;
  sourceId: string;
  sourceIds: string[];
  sourceName: string;
  title: string;
  url: string | null;
  summary: string | null;
  imageUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  channel: SourceChannel;
  channelName: string;
  bookmarkedAt: string | null;
  readAt: string | null;
}

export interface StoredArticleVersion {
  id: string;
  title: string;
  body: string;
  contentKind: ContentKind;
  language: string | null;
  contentHash: string;
  storedAt: string;
}

export interface StoredArticle extends LibraryArticle {
  version: StoredArticleVersion | null;
}

export interface LibraryData {
  nextCursor?: string | null;
  channels: ChannelRecord[];
  sources: LibrarySource[];
  articles: LibraryArticle[];
  articleCount: number;
  counts: { sources: number; articles: number; bookmarks: number };
}

export interface BookmarkListData {
  articles: LibraryArticle[];
  total: number;
  nextCursor: string | null;
}

export interface BookmarkResult {
  articleId: string;
  bookmarkedAt: string | null;
}

export interface ReadResult {
  articleId: string;
  readAt: string | null;
}

export interface FeedPreview {
  previewId: string;
  feed: {
    url: string;
    title: string;
    description: string | null;
    siteUrl: string | null;
    language: string | null;
    itemCount: number;
    items: ParsedFeedItem[];
  };
}

export interface ImportResult {
  sourceId: string;
  insertedCount: number;
  updatedCount: number;
  totalCount: number;
}

export class LibraryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}
