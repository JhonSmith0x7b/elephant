import { createHash } from "node:crypto";
import type { ContentKind, ContentFormat } from "./contracts";
import type { ParsedFeedItem } from "./rss/types";
import { sanitizeArticleHtml } from "./article-rich-text";

export interface VersionContent {
  title: string;
  body: string;
  contentKind: ContentKind;
  contentFormat?: ContentFormat;
  language: string | null;
}

export function contentVersionHash(content: VersionContent): string {
  const fields = [
    content.title, content.body, content.contentKind, content.language,
  ];
  // Preserve existing hashes so legacy previews and historical snapshots remain
  // idempotent; HTML gets its own versioned representation discriminator.
  if (content.contentFormat === "html") fields.push("html-v1");
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function versionPlainText(content: VersionContent): string {
  return content.contentFormat === "html" ? sanitizeArticleHtml(content.body).text : content.body;
}

export function extractVersionContent(item: ParsedFeedItem, language: string | null): VersionContent | null {
  const content = item.content?.trim() ? item.content : null;
  const description = item.summary?.trim() ? item.summary : null;
  const contentFormat = content && item.contentFormat === "html" ? "html" : "legacy";
  const body = contentFormat === "html" ? sanitizeArticleHtml(content!, item.url).html : content ?? description;
  if (!body) return null;
  return {
    title: item.title,
    body,
    contentFormat,
    // Legacy previews predate contentKind and only set content for actual RSS
    // content fields. A summary-only record remains a description snapshot.
    contentKind: content ? (item.contentKind ?? "rss_content") : "rss_description",
    language: language?.trim() || null,
  };
}
