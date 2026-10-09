"use client";

import { useState } from "react";

export default function ArticleCover({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;

  return <figure className="stored-article-cover">
    {/* Feed images have arbitrary hosts and unknown dimensions, as in the feed cards. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={url} alt={`${title} · 题图`} decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </figure>;
}
