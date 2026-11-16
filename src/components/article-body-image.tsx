"use client";

import { useState } from "react";

export default function ArticleBodyImage({ url, alt, embedded = false }: { url: string; alt: string; embedded?: boolean }) {
  const [failed, setFailed] = useState(false);
  const image = failed ? <span className="stored-image-unavailable">{alt || "图片"} · 暂时无法加载</span> :
      // RSS image hosts and dimensions vary; load directly, as with article covers.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return embedded ? image : <figure className="stored-inline-image">{image}</figure>;
}
