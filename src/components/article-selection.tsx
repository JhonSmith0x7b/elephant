"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Search, X } from "lucide-react";
import { buildAiModeUrl, MAX_SELECTION_LENGTH } from "@/lib/ai-mode";

type SelectedPassage = { text: string; context: string; range: Range };

function nearbyText(range: Range, root: HTMLElement): string {
  const element = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element : range.startContainer.parentElement;
  const paragraph = element?.closest("p");
  if (!paragraph || !root.contains(paragraph)) return "";
  const before = range.cloneRange();
  before.selectNodeContents(paragraph);
  before.setEnd(range.startContainer, range.startOffset);
  const characters = Array.from(paragraph.textContent || "");
  const start = Math.max(0, Array.from(before.toString()).length - 65);
  const end = Math.min(characters.length, start + 238);
  return `${start ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

export default function ArticleSelection({ title, children }: { title: string; children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const passageRef = useRef<SelectedPassage | null>(null);
  const [passage, setPassage] = useState<SelectedPassage | null>(null);
  const [withContext, setWithContext] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });

  const reposition = useCallback(() => {
    const selected = passageRef.current;
    const panel = panelRef.current;
    if (!selected || !panel || window.matchMedia("(max-width: 600px)").matches) return;
    const rects = Array.from(selected.range.getClientRects());
    const visible = rects.filter(rect => rect.bottom > 0 && rect.top < window.innerHeight);
    if (!visible.length) {
      passageRef.current = null;
      setPassage(null);
      return;
    }
    const rect = visible[visible.length - 1];
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
    const above = visible[0].top - height - 12;
    const top = above >= 16 ? above : Math.min(rect.bottom + 12, window.innerHeight - height - 16);
    setPosition({ left, top: Math.max(16, top) });
  }, []);

  const dismiss = useCallback(() => {
    passageRef.current = null;
    setPassage(null);
    const selection = window.getSelection();
    if (selection?.anchorNode && bodyRef.current?.contains(selection.anchorNode)) selection.removeAllRanges();
  }, []);

  useEffect(() => {
    let selectingWithMouse = false;
    let usingPanel = false;
    let frame = 0;

    const readSelection = () => {
      if (selectingWithMouse || usingPanel) return;
      const selection = window.getSelection();
      const root = bodyRef.current;
      const text = selection?.toString().trim() || "";
      if (!root || !selection?.rangeCount || selection.isCollapsed || !text
        || !selection.anchorNode || !selection.focusNode
        || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        passageRef.current = null;
        setPassage(null);
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const next = { text, context: nearbyText(range, root), range };
      const previous = passageRef.current;
      if (previous?.text !== next.text || previous?.context !== next.context) setWithContext(false);
      passageRef.current = next;
      setPassage(next);
    };
    const scheduleRead = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(readSelection);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      usingPanel = Boolean(panelRef.current?.contains(target));
      if (usingPanel) return;
      selectingWithMouse = event.pointerType === "mouse" && event.button === 0;
      if (!bodyRef.current?.contains(target)) {
        passageRef.current = null;
        setPassage(null);
      }
    };
    const onPointerUp = () => { selectingWithMouse = false; scheduleRead(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
      else if (!panelRef.current?.contains(event.target as Node)) usingPanel = false;
    };

    document.addEventListener("selectionchange", scheduleRead);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", scheduleRead);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
    };
  }, [dismiss, reposition]);

  useLayoutEffect(() => { reposition(); }, [passage, withContext, reposition]);

  const tooLong = passage ? Array.from(passage.text).length > MAX_SELECTION_LENGTH : false;
  const url = passage && !tooLong ? buildAiModeUrl({
    text: passage.text,
    title,
    context: withContext ? passage.context : undefined,
  }) : undefined;

  return <>
    <p className="selection-hint" lang="zh-CN"><Search size={13} aria-hidden="true" />划选正文，借助 Google AI 深入了解</p>
    <div className="stored-article-body" ref={bodyRef}>{children}</div>
    {passage && <div className="selection-panel" ref={panelRef} style={position} role="region" aria-label="划词查询" lang="zh-CN">
      <div className="selection-panel-heading"><span>继续了解</span><button type="button" className="selection-close" aria-label="关闭划词查询" onClick={dismiss}><X size={15} /></button></div>
      <p className="selection-quote" title={passage.text}>{passage.text}</p>
      {tooLong ? <p className="selection-limit" role="status">选取短一点的内容吧，最多 {MAX_SELECTION_LENGTH} 个字。</p> : <>
        <label className="selection-context-option"><input type="checkbox" checked={withContext} disabled={!passage.context} onChange={event => setWithContext(event.target.checked)} />结合上下文<span>帮助理解这里的含义</span></label>
        {withContext && <div className="selection-context-preview"><span>附带文章标题和附近文字</span><p>{passage.context}</p></div>}
        <a className="selection-search-link" href={url} target="_blank" rel="noopener noreferrer">用 Google AI 深入了解<ArrowUpRight size={15} aria-hidden="true" /></a>
        <p className="selection-destination">{withContext ? "选中文字和短上下文" : "仅选中的文字"}将发送至 Google</p>
      </>}
    </div>}
  </>;
}
