import { createHash } from "node:crypto";
import type { ContentKind } from "./contracts";
import type { ParsedFeedItem } from "./rss/types";

export interface VersionContent {
  title: string;
  body: string;
  contentKind: ContentKind;
  language: string | null;
}

export function contentVersionHash(content: VersionContent): string {
  return createHash("sha256").update(JSON.stringify([
    content.title, content.body, content.contentKind, content.language,
  ])).digest("hex");
}

export function extractVersionContent(item: ParsedFeedItem, language: string | null): VersionContent | null {
  const content = item.content?.trim() ? item.content : null;
  const description = item.summary?.trim() ? item.summary : null;
  const body = content ?? description;
  if (!body) return null;
  return {
    title: item.title,
    body,
    // Legacy previews predate contentKind and only set content for actual RSS
    // content fields. A summary-only record remains a description snapshot.
    contentKind: content ? (item.contentKind ?? "rss_content") : "rss_description",
    language: language?.trim() || null,
  };
}
