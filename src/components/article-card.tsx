"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import BookmarkButton from "@/components/bookmark-button";
import { ReadStatusControl, useArticleRead } from "@/components/read-status";
import type { LibraryArticle } from "@/lib/contracts";
import { articleHref } from "@/lib/feed-location";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function ArticleImage({ url, href, title }: { url: string; href: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <Link className="article-image" href={href} prefetch={false} aria-label={`阅读已保存版本：${title}`}>
    {/* RSS 图片地址由各来源提供，保留原图颜色。 */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </Link>;
}

export default function ArticleCard({ article, onBookmarkChange, showBookmarkDate = false, returnTo = "/" }: {
  article: LibraryArticle;
  onBookmarkChange?: (articleId: string, bookmarkedAt: string | null) => void;
  showBookmarkDate?: boolean;
  returnTo?: string;
}) {
  const href = articleHref(article.id, returnTo, article.sourceId);
  const readStatus = useArticleRead(article.id, article.readAt);
  const date = showBookmarkDate && article.bookmarkedAt
    ? article.bookmarkedAt : article.publishedAt || article.firstSeenAt;
  return <article className={`article-card${article.imageUrl ? " has-image" : ""}${readStatus.readAt ? " is-read" : ""}`} aria-labelledby={`article-title-${article.id}`}>
    {article.imageUrl && <ArticleImage key={`${article.id}-${article.imageUrl}`} url={article.imageUrl} href={href} title={article.title} />}
    <div className="article-copy">
      <div className="article-meta"><span>{article.channelName}</span><span className="meta-dot">·</span><span>{article.sourceName}</span></div>
      <h2 id={`article-title-${article.id}`}><Link href={href} prefetch={false}>{article.title}</Link></h2>
      {article.summary && <p className="article-summary">{article.summary}</p>}
      <div className="article-bottom">
        <time dateTime={date}>{showBookmarkDate ? "收藏于 " : !article.publishedAt ? "收录于 " : ""}{dateLabel(date)}</time>
        <div className="article-reading-links">
          <Link className="saved-reading-link" href={href} prefetch={false} aria-label={`阅读已保存版本：${article.title}`}>阅读已保存版本</Link>
          {article.url && <a className="original-reading-link" href={article.url} target="_blank" rel="noopener noreferrer" onClick={() => { if (!readStatus.readAt) void readStatus.setRead(true); }} aria-label={`在新窗口打开原文：${article.title}`}>原文<ArrowUpRight size={12} /></a>}
          <ReadStatusControl {...readStatus} />
          <BookmarkButton articleId={article.id} bookmarkedAt={article.bookmarkedAt} compact onChange={value => onBookmarkChange?.(article.id, value)} />
        </div>
      </div>
    </div>
  </article>;
}
