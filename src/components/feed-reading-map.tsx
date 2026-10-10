"use client";

import { useEffect, useRef, useState } from "react";
import { ListTree, X } from "lucide-react";
import type { LibraryArticle } from "@/lib/contracts";
import { useArticleRead } from "./read-status";
import "./feed-reading-map.css";

function articleElement(id: string) {
  return document.getElementById(`article-title-${id}`)?.closest<HTMLElement>(".article-card");
}

function PositionButton({ article, active, mobile, onJump, onPreview }: {
  article: LibraryArticle; active: boolean; mobile?: boolean;
  onJump: () => void; onPreview?: (element: HTMLElement | null) => void;
}) {
  const { readAt } = useArticleRead(article.id, article.readAt);
  return <button type="button" className={`reading-map-item${active ? " is-current" : ""}${readAt ? " is-read" : ""}`}
    aria-label={article.title} aria-current={active ? "location" : undefined}
    data-reading-id={article.id} onClick={onJump}
    onMouseEnter={event => onPreview?.(event.currentTarget)} onMouseLeave={() => onPreview?.(null)}
    onFocus={event => onPreview?.(event.currentTarget)} onBlur={() => onPreview?.(null)}>
    <span className="reading-map-tick" aria-hidden="true" />
    {mobile && <span className="reading-map-item-title">{article.title}<small>{article.sourceName}{readAt ? " · 已读" : ""}</small></span>}
  </button>;
}

export default function FeedReadingMap({ articles }: { articles: LibraryArticle[] }) {
  const [current, setCurrent] = useState("");
  const [preview, setPreview] = useState<{ title: string; top: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let frame = 0;
    const locate = () => {
      const article = articles.find(item => (articleElement(item.id)?.getBoundingClientRect().bottom ?? -1) > 100) || articles.at(-1);
      if (article) setCurrent(article.id);
    };
    const scroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(locate); };
    locate();
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", scroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", scroll);
    };
  }, [articles]);

  function jump(articleId: string) {
    const element = articleElement(articleId);
    if (!element) return;
    dialog.current?.close();
    window.scrollTo({ top: articleId === articles[0]?.id ? 0 : Math.max(0, window.scrollY + element.getBoundingClientRect().top - 80), behavior: "instant" });
    setCurrent(articleId);
    setPreview(null);
  }

  if (!articles.length) return null;
  return <>
    <nav className="reading-map-rail" aria-label="文章位置导航">
      <button className="reading-map-open" type="button" aria-label="打开文章标题列表" onClick={() => dialog.current?.showModal()}><ListTree size={17} /></button>
      <div className="reading-map-ticks">{articles.map(article => <PositionButton key={article.id} article={article} active={current === article.id} onJump={() => jump(article.id)}
        onPreview={element => setPreview(element ? { title: article.title, top: Math.min(window.innerHeight - 150, Math.max(80, element.getBoundingClientRect().top - 10)) } : null)} />)}</div>
    </nav>
    {preview && <div className="reading-map-preview" style={{ top: preview.top }}>{preview.title}</div>}
    <button type="button" className="reading-map-mobile" onClick={() => dialog.current?.showModal()}><ListTree size={15} />文章导航</button>
    <dialog ref={dialog} className="reading-map-dialog" aria-labelledby="reading-map-heading" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="reading-map-dialog-head"><div><h2 id="reading-map-heading">文章导航</h2><p>已加载 {articles.length} 篇 · 点击标题定位</p></div><button type="button" aria-label="关闭文章导航" onClick={() => dialog.current?.close()}><X size={20} /></button></div>
      <div className="reading-map-title-list">{articles.map(article => <PositionButton key={article.id} mobile article={article} active={current === article.id} onJump={() => jump(article.id)} />)}</div>
    </dialog>
  </>;
}
