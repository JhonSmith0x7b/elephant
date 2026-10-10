import { Fragment, type ReactNode } from "react";
import { articleTextParts } from "../lib/article-links";
import ArticleBodyImage from "./article-body-image";

export default function ArticleBody({ body, base }: { body: string; base?: string | null }) {
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
