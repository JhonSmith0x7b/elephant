"use client";

import { ThemeSelect } from "./theme-provider";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bookmark, LoaderCircle, RefreshCw } from "lucide-react";
import ArticleCard from "@/components/article-card";
import BrandWordmark from "@/components/brand-wordmark";
import { READ_CHANGE_EVENT, type ReadChangeDetail } from "@/components/read-status";
import type { BookmarkListData, LibraryArticle } from "@/lib/contracts";
import "./bookmarks.css";

type LoadMode = "initial" | "refresh" | "more";

async function fetchBookmarks(cursor: string | null, signal: AbortSignal): Promise<BookmarkListData> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(`/api/bookmarks${query}`, { cache: "no-store", signal });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "暂时无法读取收藏，请重试。");
  if (!result || !Array.isArray(result.articles) || typeof result.total !== "number") {
    throw new Error("收藏列表暂时无法读取，请重试。");
  }
  return result as BookmarkListData;
}

export default function BookmarksApp() {
  const [data, setData] = useState<BookmarkListData | null>(null);
  const [loading, setLoading] = useState<LoadMode | null>("initial");
  const [error, setError] = useState("");
  const [failedMode, setFailedMode] = useState<LoadMode>("initial");
  const [notice, setNotice] = useState("");
  const currentData = useRef<BookmarkListData | null>(null);
  const loadedPages = useRef(1);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (mode: LoadMode) => {
    const previousData = currentData.current;
    if (mode === "more" && !previousData?.nextCursor) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(mode);
    setError("");
    let cursor = mode === "more" ? previousData!.nextCursor : null;
    const pageCount = mode === "refresh" ? loadedPages.current : 1;
    let next: BookmarkListData | null = null;
    let pagesRead = 0;
    try {
      for (let page = 0; page < pageCount; page += 1) {
        const result = await fetchBookmarks(cursor, controller.signal);
        pagesRead += 1;
        const articles: LibraryArticle[] = [...(next?.articles ?? (mode === "more" ? previousData!.articles : [])), ...result.articles];
        next = { ...result, articles: [...new Map(articles.map(article => [article.id, article])).values()] };
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      if (request.current !== controller || !next) return;
      currentData.current = next;
      setData(next);
      loadedPages.current = mode === "more" ? loadedPages.current + pagesRead : pagesRead;
    } catch (cause) {
      if (request.current !== controller || controller.signal.aborted) return;
      setFailedMode(mode);
      setError(cause instanceof Error && cause.name !== "TypeError"
        ? cause.message : "暂时无法连接服务，请检查网络后重试。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(null);
      }
    }
  }, []);

  useEffect(() => {
    void load(currentData.current ? "refresh" : "initial");
    function refreshWhenIdle() {
      if (!request.current && document.visibilityState === "visible") {
        void load(currentData.current ? "refresh" : "initial");
      }
    }
    window.addEventListener("focus", refreshWhenIdle);
    window.addEventListener("pageshow", refreshWhenIdle);
    return () => {
      request.current?.abort();
      request.current = null;
      window.removeEventListener("focus", refreshWhenIdle);
      window.removeEventListener("pageshow", refreshWhenIdle);
    };
  }, [load]);

  const onBookmarkChange = useCallback((articleId: string, bookmarkedAt: string | null) => {
    const previous = currentData.current;
    if (!previous?.articles.some(article => article.id === articleId)) return;
    // A completed mutation wins over an older, still-running list request.
    request.current?.abort();
    request.current = null;
    setLoading(null);
    setError("");
    const next = {
      ...previous,
      articles: bookmarkedAt
        ? previous.articles.map(article => article.id === articleId ? { ...article, bookmarkedAt } : article)
        : previous.articles.filter(article => article.id !== articleId),
      total: bookmarkedAt ? previous.total : Math.max(0, previous.total - 1),
    };
    currentData.current = next;
    setData(next);
    if (!bookmarkedAt) setNotice("已取消收藏。");
  }, []);

  useEffect(() => {
    const onReadChange = (event: Event) => {
      const { articleId, readAt } = (event as CustomEvent<ReadChangeDetail>).detail;
      const previous = currentData.current;
      if (!previous?.articles.some(article => article.id === articleId)) return;
      request.current?.abort();
      request.current = null;
      setLoading(null);
      const next = { ...previous, articles: previous.articles.map(article =>
        article.id === articleId ? { ...article, readAt } : article) };
      currentData.current = next;
      setData(next);
    };
    window.addEventListener(READ_CHANGE_EVENT, onReadChange);
    return () => window.removeEventListener(READ_CHANGE_EVENT, onReadChange);
  }, []);

  return <main className="reading-room bookmarks-room">
    <header className="stored-masthead bookmarks-masthead">
      <Link className="brand" href="/" prefetch={false} aria-label="大象，返回信息流"><BrandWordmark /></Link>
      <div className="stored-masthead-actions"><ThemeSelect /><Link className="return-to-feed" href="/" prefetch={false}><ArrowLeft size={14} aria-hidden="true" />返回信息流</Link></div>
    </header>

    <section aria-labelledby="bookmarks-heading">
      <div className="bookmarks-heading">
        <div>
          <span className="bookmarks-kicker" lang="en">KEPT FOR ANOTHER DAY</span>
          <div className="bookmarks-title-row">
            <h1 id="bookmarks-heading">我的收藏</h1>
            {data ? <span className="bookmarks-count">{data.total} 篇</span> : null}
          </div>
          <p>把值得重读的文章，留在这里。</p>
        </div>
        {data ? <button className="text-button bookmarks-refresh" type="button" disabled={Boolean(loading)}
          onClick={() => void load("refresh")} aria-label="刷新收藏列表">
          <RefreshCw size={13} className={loading === "refresh" ? "spinning" : undefined} aria-hidden="true" />
          <span>{loading === "refresh" ? "刷新中" : "刷新"}</span>
        </button> : null}
      </div>

      <div className="bookmarks-feedback" role="status" aria-live="polite">{notice}</div>
      {error ? <div className="error-message library-error" role="alert">
        <span>{error}</span><button type="button" className="text-button" onClick={() => void load(failedMode)}>重试</button>
      </div> : null}
      {!data && loading ? <div className="loading-state" role="status">
        <LoaderCircle size={22} className="spinning" aria-hidden="true" /><p>正在打开收藏…</p>
      </div> : null}
      {data?.total === 0 ? <div className="empty-state bookmarks-empty">
        <Bookmark size={32} strokeWidth={1.15} aria-hidden="true" />
        <h2>留一篇，给下一次阅读</h2>
        <p>在信息流或文章页点一下「收藏」，<br />重要的文章就会收在这里。</p>
        <Link className="button secondary" href="/" prefetch={false}>去看看文章</Link>
      </div> : null}
      {data && data.total > 0 ? <>
        <div className="bookmarks-order">按收藏时间排列 · 最近收藏在前</div>
        <div className="article-feed list" aria-busy={Boolean(loading)}>
          {data.articles.map(article => <ArticleCard key={article.id} article={article}
            onBookmarkChange={onBookmarkChange} showBookmarkDate />)}
        </div>
        {data.nextCursor ? <div className="bookmarks-load-more">
          <button type="button" className="button secondary" disabled={Boolean(loading)} onClick={() => void load("more")}>
            {loading === "more" ? <LoaderCircle size={14} className="spinning" aria-hidden="true" /> : null}
            {loading === "more" ? "正在加载…" : "加载更多收藏"}
          </button>
        </div> : <p className="feed-end">— 收藏的文章，都在这里了 —</p>}
      </> : null}
    </section>
    <footer className="page-footer"><span>大象 · 私人信息流</span><span>值得留住的，随时再读。</span></footer>
  </main>;
}
