"use client";

import { patchCachedArticle } from "@/lib/feed-cache";

import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { CheckCheck, Circle, LoaderCircle } from "lucide-react";

export const READ_CHANGE_EVENT = "article-read-change";
export interface ReadChangeDetail { articleId: string; readAt: string | null }

export function useArticleRead(articleId: string, initialReadAt: string | null, autoMark = false) {
  const [readAt, setReadAt] = useState(initialReadAt);
  const [previous, setPrevious] = useState({ articleId, initialReadAt });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  if (previous.articleId !== articleId || previous.initialReadAt !== initialReadAt) {
    setPrevious({ articleId, initialReadAt });
    setReadAt(initialReadAt);
    if (previous.articleId !== articleId) {
      setPending(false);
      setError("");
    }
  }

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [articleId]);

  const setRead = useCallback(async (read: boolean) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/articles/${encodeURIComponent(articleId)}/read`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
        signal: controller.signal,
        keepalive: true,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "阅读状态未能保存，请重试。");
      if (!result || result.articleId !== articleId ||
          !(result.readAt === null || typeof result.readAt === "string")) {
        throw new Error("无法确认阅读状态，请重试。");
      }
      if (request.current !== controller) return;
      setReadAt(result.readAt);
      patchCachedArticle(articleId, { readAt: result.readAt });
      window.dispatchEvent(new CustomEvent<ReadChangeDetail>(READ_CHANGE_EVENT, {
        detail: { articleId, readAt: result.readAt },
      }));
    } catch (cause) {
      if (request.current !== controller) return;
      setError(cause instanceof Error && cause.name !== "AbortError" && cause.name !== "TypeError"
        ? cause.message : "阅读状态未能保存，请检查网络后重试。");
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }, [articleId]);

  const markOpened = useEffectEvent(() => {
    if (!readAt) void setRead(true);
  });
  // Only an opened reading page marks an article read; prefetching does not.
  // A manual "unread" choice stays in effect for the rest of this visit.
  useEffect(() => {
    if (autoMark) markOpened();
  }, [articleId, autoMark]);

  return { readAt, pending, error, setRead };
}

export function ReadStatusControl({ readAt, pending, error, setRead }: ReturnType<typeof useArticleRead>) {
  const errorId = useId();
  return <span className="read-status-control">
    <button type="button" className="read-status-button" disabled={pending}
      aria-pressed={Boolean(readAt)} aria-busy={pending}
      aria-label={readAt ? "标为未读" : "标为已读"}
      aria-describedby={error ? errorId : undefined}
      title={readAt ? "已读，点击标为未读" : "标为已读"}
      onClick={() => void setRead(!readAt)}>
      {pending ? <LoaderCircle size={13} className="spinning" aria-hidden="true" />
        : readAt ? <CheckCheck size={14} aria-hidden="true" /> : <Circle size={11} aria-hidden="true" />}
      <span>{pending ? "保存中" : readAt ? "已读" : "标为已读"}</span>
    </button>
    {error && <span id={errorId} className="read-status-error" role="alert">{error}</span>}
  </span>;
}

export default function ArticleReadStatus({ articleId, readAt }: { articleId: string; readAt: string | null }) {
  const status = useArticleRead(articleId, readAt, true);
  return <ReadStatusControl {...status} />;
}
