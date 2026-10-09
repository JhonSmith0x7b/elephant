"use client";

import { patchCachedArticle } from "@/lib/feed-cache";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, LoaderCircle } from "lucide-react";
import "./bookmarks.css";

export const BOOKMARK_CHANGE_EVENT = "bookmark-change";
export interface BookmarkChangeDetail { articleId: string; bookmarkedAt: string | null }

export default function BookmarkButton({ articleId, bookmarkedAt, onChange, compact = false }: {
  articleId: string;
  bookmarkedAt: string | null;
  onChange?: (bookmarkedAt: string | null) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const errorId = useId();
  const [savedAt, setSavedAt] = useState(bookmarkedAt);
  const [previous, setPrevious] = useState({ articleId, bookmarkedAt });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  // Reconcile a refreshed server value without resetting a successful local update.
  if (previous.articleId !== articleId || previous.bookmarkedAt !== bookmarkedAt) {
    if (previous.articleId !== articleId) {
      setPending(false);
      setError("");
    }
    setPrevious({ articleId, bookmarkedAt });
    setSavedAt(bookmarkedAt);
  }

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [articleId]);

  async function toggleBookmark() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(articleId)}/bookmark`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: !savedAt }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "收藏未能保存，请重试。");
      if (!result || result.articleId !== articleId ||
          !(result.bookmarkedAt === null || typeof result.bookmarkedAt === "string")) {
        throw new Error("无法确认收藏状态，请重试。");
      }
      if (request.current !== controller) return;
      const detail: BookmarkChangeDetail = { articleId, bookmarkedAt: result.bookmarkedAt };
      setSavedAt(detail.bookmarkedAt);
      patchCachedArticle(articleId, { bookmarkedAt: detail.bookmarkedAt }, { bookmarkedAt: savedAt });
      onChange?.(detail.bookmarkedAt);
      window.dispatchEvent(new CustomEvent<BookmarkChangeDetail>(BOOKMARK_CHANGE_EVENT, { detail }));
      router.refresh();
    } catch (cause) {
      if (request.current !== controller) return;
      setError(cause instanceof Error && cause.name !== "AbortError" && cause.name !== "TypeError"
        ? cause.message : "暂时无法连接服务，请重试。");
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }

  return <span className={`bookmark-control${compact ? " compact" : ""}`}>
    <button type="button" className="bookmark-button" onClick={toggleBookmark}
      aria-pressed={Boolean(savedAt)} aria-busy={pending} disabled={pending}
      aria-describedby={error ? errorId : undefined}
      title={savedAt ? "取消收藏" : "收藏这篇文章"}>
      {pending ? <LoaderCircle size={15} className="spinning" aria-hidden="true" />
        : <Bookmark size={15} fill={savedAt ? "currentColor" : "none"} aria-hidden="true" />}
      <span>{savedAt ? "已收藏" : "收藏"}</span>
    </button>
    {error ? <span id={errorId} className="bookmark-error" role="alert">
      {error} <button type="button" onClick={toggleBookmark} disabled={pending}>重试</button>
    </span> : null}
  </span>;
}
