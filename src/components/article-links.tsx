import { articleTextParts } from "../lib/article-links";

export default function ArticleLinks({ text, base }: { text: string; base?: string | null }) {
  return articleTextParts(text, base).map((part, index) => part.href
    ? <a key={index} className="stored-body-link" href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
    : part.text);
}
