import { createElement, Fragment, type ReactNode } from "react";
import { articleTextParts } from "../lib/article-links";
import { articleRichTextNodes, type ArticleRichTextNode } from "../lib/article-rich-text";
import ArticleBodyImage from "./article-body-image";

function renderRichNodes(nodes: ArticleRichTextNode[], base?: string | null, plain = false): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return plain ? node.text : <Fragment key={index}>{articleTextParts(node.text, base).map((part, partIndex) => part.image
      ? part.href && <ArticleBodyImage key={partIndex} url={part.href} alt={part.text} embedded />
      : part.href ? <a key={partIndex} className="stored-body-link" href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a> : part.text)}</Fragment>;
    const children = renderRichNodes(node.children, base, plain || ["a", "pre", "code"].includes(node.tag));
    if (node.tag === "img") return <ArticleBodyImage key={index} url={node.attributes.src} alt={node.attributes.alt || ""} embedded />;
    if (node.tag === "a") return <a key={index} className="stored-body-link" href={node.attributes.href} target="_blank" rel="noopener noreferrer">{children}</a>;
    if (node.tag === "table") return <div key={index} className="stored-table-scroll" role="region" aria-label="文章表格，可横向滚动" tabIndex={0}><table>{children}</table></div>;
    // The shared parser only emits whitelisted semantic tags and attributes.
    // Explicit React props avoid interpreting source attributes or raw HTML.
    return createElement(node.tag, {
      key: index,
      ...(node.tag === "ol" && node.attributes.start ? { start: Number(node.attributes.start) } : {}),
      ...(["td", "th"].includes(node.tag) && node.attributes.colspan ? { colSpan: Number(node.attributes.colspan) } : {}),
      ...(["td", "th"].includes(node.tag) && node.attributes.rowspan ? { rowSpan: Number(node.attributes.rowspan) } : {}),
    }, ...children);
  });
}

export function articleBodyHasImage(body: string, url: string, base?: string | null, format: "legacy" | "html" = "legacy"): boolean {
  if (format !== "html") return articleTextParts(body, base).some(part => part.image && part.href === url);
  const includesImage = (nodes: ArticleRichTextNode[]): boolean => nodes.some(node => node.type === "element"
    && ((node.tag === "img" && node.attributes.src === url) || includesImage(node.children)));
  return includesImage(articleRichTextNodes(body, base));
}

export default function ArticleBody({ body, base, format = "legacy" }: { body: string; base?: string | null; format?: "legacy" | "html" }) {
  if (format === "html") return <div className="stored-rich-body">{renderRichNodes(articleRichTextNodes(body, base), base)}</div>;
  return body.trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map((paragraph, index) => {
    const blocks: ReactNode[] = [];
    let inline: ReactNode[] = [];
    const flush = () => {
      if (inline.some(node => typeof node !== "string" || node.trim())) blocks.push(<p key={`text-${blocks.length}`}>{inline}</p>);
      inline = [];
    };
    for (const [i, part] of articleTextParts(paragraph, base).entries()) {
      if (part.image) {
        flush();
        if (part.href) blocks.push(<ArticleBodyImage key={`image-${i}`} url={part.href} alt={part.text} />);
      } else if (part.href) {
        inline.push(<a key={i} className="stored-body-link" href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>);
      } else if (part.text) inline.push(part.text);
    }
    flush();
    return <Fragment key={index}>{blocks}</Fragment>;
  });
}
