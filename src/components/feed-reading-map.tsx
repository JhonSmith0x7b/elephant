"use client";

import { useEffect, useRef, useState } from "react";
import { ListTree, MapPin, X } from "lucide-react";
import type { LibraryArticle } from "@/lib/contracts";
import { parseReadingPositions, READING_POSITIONS_KEY, saveReadingPosition, type ReadingPosition } from "@/lib/reading-position";
import { useArticleRead } from "./read-status";
import "./feed-reading-map.css";

function articleElement(id: string) {
  return document.getElementById(`article-title-${id}`)?.closest<HTMLElement>(".article-card");
}

function PositionButton({ article, active, last, mobile, onJump, onPreview }: {
  article: LibraryArticle; active: boolean; last: boolean; mobile?: boolean;
  onJump: () => void; onPreview?: (element: HTMLElement | null) => void;
}) {
  const { readAt } = useArticleRead(article.id, article.readAt);
  return <button type="button" className={`reading-map-item${active ? " is-current" : ""}${readAt ? " is-read" : ""}${last ? " is-last" : ""}`}
    aria-label={`${article.title}${last ? "，上次读到这里" : ""}`} aria-current={active ? "location" : undefined}
    data-reading-id={article.id} onClick={onJump}
    onMouseEnter={event => onPreview?.(event.currentTarget)} onMouseLeave={() => onPreview?.(null)}
    onFocus={event => onPreview?.(event.currentTarget)} onBlur={() => onPreview?.(null)}>
    <span className="reading-map-tick" aria-hidden="true" />
    {mobile && <span className="reading-map-item-title">{article.title}<small>{last ? "上次读到这里 · " : ""}{article.sourceName}{readAt ? " · 已读" : ""}</small></span>}
  </button>;
}

export default function FeedReadingMap({ articles, scope, onRestore }: {
  articles: LibraryArticle[]; scope: string; onRestore: (articleId: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const [last, setLast] = useState<ReadingPosition | null>(null);
  const [current, setCurrent] = useState("");
  const [preview, setPreview] = useState<{ title: string; top: number; last: boolean } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const restoreRequest = useRef<AbortController | null>(null);
  const armed = useRef(false);
  const pendingPosition = useRef<ReadingPosition | null>(null);

  useEffect(() => {
    try { setLast(parseReadingPositions(localStorage.getItem(READING_POSITIONS_KEY))[scope] || null); } catch { /* Storage optional. */ }
    return () => { restoreRequest.current?.abort(); };
  }, [scope]);

  useEffect(() => {
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (pendingPosition.current) saveReadingPosition(scope, pendingPosition.current);
      pendingPosition.current = null;
    };
    const locate = (persist: boolean) => {
      const article = articles.find(item => (articleElement(item.id)?.getBoundingClientRect().bottom ?? -1) > 100) || articles.at(-1);
      if (!article) return;
      setCurrent(article.id);
      if (persist && armed.current && !restoreRequest.current) {
        pendingPosition.current = { articleId: article.id, title: article.title.slice(0, 2000), savedAt: Date.now() };
        clearTimeout(timer);
        timer = setTimeout(save, 250);
      }
    };
    const scroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => locate(true)); };
    const arm = () => { armed.current = true; };
    const key = (event: KeyboardEvent) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) arm(); };
    const rememberOpenedArticle = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("a")) return;
      const card = target.closest(".article-card");
      const article = articles.find(item => card?.getAttribute("aria-labelledby") === `article-title-${item.id}`);
      if (article) {
        pendingPosition.current = { articleId: article.id, title: article.title.slice(0, 2000), savedAt: Date.now() };
        save();
      }
    };
    locate(false);
    document.addEventListener("click", rememberOpenedArticle, true);
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("wheel", arm, { passive: true });
    window.addEventListener("touchmove", arm, { passive: true });
    window.addEventListener("pointerdown", arm, { passive: true });
    window.addEventListener("keydown", key);
    window.addEventListener("pagehide", save);
    return () => {
      cancelAnimationFrame(frame); clearTimeout(timer); save();
      window.removeEventListener("scroll", scroll); window.removeEventListener("wheel", arm);
      window.removeEventListener("touchmove", arm); window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", key); window.removeEventListener("pagehide", save);
      document.removeEventListener("click", rememberOpenedArticle, true);
    };
  }, [articles, scope]);

  useEffect(() => {
    const container = rail.current;
    const tick = container?.querySelector<HTMLElement>("[aria-current='location']");
    if (container && tick) {
      const top = tick.offsetTop;
      if (top < container.scrollTop || top + tick.offsetHeight > container.scrollTop + container.clientHeight)
        container.scrollTop = top - container.clientHeight / 2;
    }
  }, [current]);

  function jump(articleId: string, fromRestore = false) {
    const element = articleElement(articleId);
    if (!element) return false;
    if (!fromRestore && restoreRequest.current) {
      restoreRequest.current.abort(); restoreRequest.current = null; setRestoring(false);
    }
    pendingPosition.current = null;
    dialog.current?.close();
    armed.current = true;
    window.scrollTo({ top: Math.max(0, window.scrollY + element.getBoundingClientRect().top - 80), behavior: "instant" });
    setCurrent(articleId); setPreview(null);
    const article = articles.find(item => item.id === articleId);
    const title = article?.title || last?.title || "";
    saveReadingPosition(scope, { articleId, title: title.slice(0, 2000), savedAt: Date.now() });
    return true;
  }

  async function restore() {
    if (!last || restoreRequest.current) return;
    setMessage("");
    if (jump(last.articleId)) return;
    const controller = new AbortController();
    restoreRequest.current = controller; setRestoring(true);
    try {
      const found = await onRestore(last.articleId, controller.signal);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (controller.signal.aborted) return;
      if (!found || !jump(last.articleId, true)) setMessage("这篇文章已不在当前列表中，可继续浏览已加载的标题。");
    } catch {
      if (!controller.signal.aborted) setMessage("暂时无法找回阅读位置，请重试。");
    } finally {
      if (restoreRequest.current === controller) { restoreRequest.current = null; setRestoring(false); }
    }
  }

  const resume = <div className="reading-map-resume">
    {last && <button type="button" disabled={restoring} onClick={() => void restore()} title={last.title}><MapPin size={13} />{restoring ? "正在找回位置…" : "回到上次位置"}</button>}
    {last && <p className="reading-map-last-title">上次：{last.title}</p>}
    {restoring && <button type="button" onClick={() => { restoreRequest.current?.abort(); restoreRequest.current = null; setRestoring(false); }}>取消</button>}
    {message && <p role="status">{message}</p>}
  </div>;

  if (!articles.length) return null;
  return <>
    <nav className="reading-map-rail" aria-label="文章位置导航">
      <button className="reading-map-open" type="button" aria-label="打开文章标题列表" onClick={() => dialog.current?.showModal()}><ListTree size={17} /></button>
      <div className="reading-map-ticks" ref={rail} onScroll={() => setPreview(null)}>{articles.map(article => <PositionButton key={article.id} article={article} active={current === article.id} last={last?.articleId === article.id} onJump={() => jump(article.id)}
        onPreview={element => setPreview(element ? { title: article.title, top: Math.min(window.innerHeight - 150, Math.max(80, element.getBoundingClientRect().top - 10)), last: last?.articleId === article.id } : null)} />)}</div>
      {last && <button className="reading-map-pin" type="button" aria-label="回到上次阅读位置" title={`上次读到：${last.title}`} onClick={() => void restore()}><MapPin size={16} /></button>}
      {(restoring || message) && <div className="reading-map-status">{resume}</div>}
    </nav>
    {preview && <div className="reading-map-preview" style={{ top: preview.top }}>{preview.last && <small>上次读到这里</small>}{preview.title}</div>}
    <button type="button" className="reading-map-mobile" onClick={() => dialog.current?.showModal()}><ListTree size={15} />阅读位置</button>
    <dialog ref={dialog} className="reading-map-dialog" aria-labelledby="reading-map-heading" onClose={() => { restoreRequest.current?.abort(); restoreRequest.current = null; setRestoring(false); }} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="reading-map-dialog-head"><div><h2 id="reading-map-heading">阅读位置</h2><p>已加载 {articles.length} 篇 · 点击标题定位</p></div><button type="button" aria-label="关闭阅读位置" onClick={() => dialog.current?.close()}><X size={20} /></button></div>
      {resume}
      <div className="reading-map-title-list">{articles.map(article => <PositionButton key={article.id} mobile article={article} active={current === article.id} last={last?.articleId === article.id} onJump={() => jump(article.id)} />)}</div>
    </dialog>
  </>;
}
