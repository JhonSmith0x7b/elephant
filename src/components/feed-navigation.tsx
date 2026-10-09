"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp } from "lucide-react";
import type { ChannelRecord } from "@/lib/contracts";
import "./feed-navigation.css";

export default function FeedNavigation({ mastheadRef, headingRef, channels, channel, onSelect }: {
  mastheadRef: RefObject<HTMLElement | null>;
  headingRef: RefObject<HTMLDivElement | null>;
  channels: ChannelRecord[];
  channel: string;
  onSelect: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const activeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const masthead = mastheadRef.current;
    if (!masthead) return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.boundingClientRect.bottom <= 48);
    }, { rootMargin: "-48px 0px 0px 0px" });
    observer.observe(masthead);
    return () => observer.disconnect();
  }, [mastheadRef]);

  useEffect(() => {
    if (visible) activeButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [channel, visible]);

  if (!visible) return null;
  return <>
    <div className="compact-feed-bar">
      <div className="compact-feed-inner">
        <span className="compact-feed-brand" aria-hidden="true">大象</span>
        <nav className="compact-channel-nav" aria-label="快捷分类">
          {channels.map(item => <button key={item.id} type="button"
            ref={channel === item.id ? activeButton : undefined}
            aria-pressed={channel === item.id} title={item.name}
            onClick={() => {
              onSelect(item.id);
              // Show the start of the selected feed instead of keeping an old
              // category's deep scroll position. History remains URL-driven.
              headingRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
            }}>{item.name}</button>)}
        </nav>
      </div>
    </div>
    <button type="button" className="back-to-top" aria-label="返回顶部" title="返回顶部"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
        mastheadRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }}><ArrowUp size={18} aria-hidden="true" /></button>
  </>;
}
