import ArticleLinks from "./article-links";
import "./article-links.css";
import Link from "next/link";
import BrandWordmark from "@/components/brand-wordmark";
import ArticleSelection from "@/components/article-selection";
import BookmarkButton from "@/components/bookmark-button";
import ArticleReadStatus from "@/components/read-status";
import { ArrowLeft, ArrowUpRight, BookOpen, Bookmark } from "lucide-react";
import type { StoredArticle } from "@/lib/contracts";

function formatDate(value: string, includeTime = false) {
  if (Number.isNaN(Date.parse(value))) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } as const : {}),
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function languageTag(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

export default function StoredArticleView({ article, returnTo = "/" }: {
  article: StoredArticle;
  returnTo?: string;
}) {
  const { version } = article;
  const title = version?.title || article.title;
  const language = languageTag(version?.language);
  const paragraphs = version?.body.trim().split(/\r?\n\s*\r?\n/).filter(Boolean) ?? [];
  const savedAt = version?.storedAt;

  return (
    <div className="reading-room stored-reading-room">
      <header className="stored-masthead">
        <Link className="brand" href={returnTo} aria-label="大象，返回信息流">
          <BrandWordmark />
        </Link>
        <div className="stored-masthead-actions"><Link className="text-button bookmarks-nav-link" href="/bookmarks" prefetch={false}><Bookmark size={14} />我的收藏</Link><Link className="text-button return-to-feed" href={returnTo}><ArrowLeft size={15} />返回信息流</Link></div>
      </header>

      <main className="stored-article" lang={language}>
        <article aria-labelledby="stored-article-title">
          <header className="stored-article-heading">
            <div className="stored-article-kicker" lang="zh-CN"><span>{article.channelName}</span><span aria-hidden="true">/</span><span>{article.sourceName}</span></div>
            <h1 id="stored-article-title">{title}</h1>
            <div className="stored-article-byline" lang="zh-CN">
              {article.author && <span>作者 · <span lang={language}>{article.author}</span></span>}
              <span>{article.publishedAt ? "发布于 " : "收录于 "}<time dateTime={article.publishedAt || article.firstSeenAt}>{formatDate(article.publishedAt || article.firstSeenAt)}</time></span>
            </div>
          </header>

          <div className="stored-version-bar" lang="zh-CN">
            <div className="stored-version-info"><span className="stored-version-label"><BookOpen size={14} />{version ? "已保存内容" : "文章收录记录"}</span>{savedAt && <span className="stored-version-date">保存于 <time dateTime={savedAt}>{formatDate(savedAt, true)}</time></span>}</div>
            <div className="stored-reading-actions"><ArticleReadStatus key={article.id} articleId={article.id} readAt={article.readAt} /><BookmarkButton articleId={article.id} bookmarkedAt={article.bookmarkedAt} compact />{article.url && <a className="stored-original-link" href={article.url} target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开原文">打开原站<ArrowUpRight size={14} /></a>}</div>
          </div>

          {version?.contentKind === "rss_description" && <p className="stored-content-note" lang="zh-CN">内容来自 RSS 摘要，已保存来源提供的文本，可能不是全文。</p>}

          {paragraphs.length > 0 ? <ArticleSelection key={version?.id} title={title}>{paragraphs.map((paragraph, index) => <p key={index}><ArticleLinks text={paragraph} base={article.url} /></p>)}</ArticleSelection> : <section className="stored-content-empty" lang="zh-CN" aria-labelledby="missing-content-heading"><BookOpen size={27} strokeWidth={1.3} /><h2 id="missing-content-heading">尚未获得可阅读的内容</h2><p>这篇文章目前没有保存的正文或摘要。{article.url ? "可以打开原文阅读，或返回信息流刷新来源。" : "来源也未提供原文链接，可以返回信息流刷新来源。"}</p><Link className="button secondary" href={returnTo}>返回信息流<ArrowLeft size={14} /></Link></section>}

          {paragraphs.length > 0 && <footer className="stored-article-end" lang="zh-CN"><span className="stored-end-mark" aria-hidden="true" /><p>内容来自 {article.sourceName}。此处展示采集时保存的内容。</p><Link className="text-button" href={returnTo}><ArrowLeft size={14} />回到信息流，继续阅读</Link></footer>}
        </article>
      </main>

      <footer className="page-footer" lang="zh-CN"><span>大象 <span className="footer-divider">/</span> 留一点时间，给阅读。</span><span>保留出处，也留住读到的内容。</span></footer>
    </div>
  );
}
