export type ArticleTextPart = { text: string; href?: string };

/** Destinations are navigation only: never interpret HTML or executable schemes. */
export function articleLinkUrl(value: string, base?: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value, base || undefined);
    return /^(https?:)$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
    // A Markdown link may wrap lines, but must not consume another paragraph.
    if (text[i] === "\n" && /^\n\s*\n/.test(text.slice(i))) return -1;
  }
  return -1;
}

const unescapeLabel = (text: string) => text.replace(/\\([\\\[\]])/g, "$1");

/** A small inline-link reader, intentionally not a Markdown/HTML renderer. */
export function articleTextParts(text: string, base?: string | null): ArticleTextPart[] {
  const parts: ArticleTextPart[] = [];
  let plain = "";
  const emit = (part: ArticleTextPart) => {
    if (plain) { parts.push({ text: plain }); plain = ""; }
    parts.push(part);
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "[" && text[i - 1] !== "\\" && text[i - 1] !== "!") {
      const labelEnd = closing(text, i, "[", "]");
      if (labelEnd >= 0 && text[labelEnd + 1] === "(") {
        const end = closing(text, labelEnd + 1, "(", ")");
        if (end >= 0) {
          const destination = text.slice(labelEnd + 2, end).trim();
          // Common Markdown destinations can include a quoted hover title.
          const match = destination.match(/^(?:<([^<>]+)>|(\S+?))(?:\s+["'][\s\S]*["'])?$/);
          const href = match ? articleLinkUrl(match[1] || match[2], base) : undefined;
          emit({ text: unescapeLabel(text.slice(i + 1, labelEnd)), ...(href ? { href } : {}) });
          i = end + 1;
          continue;
        }
      }
    }
    if ((text[i] === "h" || text[i] === "H") && /^https?:\/\//i.test(text.slice(i, i + 8)) && (i === 0 || !/[\w/]/.test(text[i - 1]))) {
      let raw = text.slice(i).match(/^https?:\/\/[^\s<>"'\[\]，。；：！？、]+/i)?.[0] || "";
      raw = raw.replace(/[.,;:!?]+$/, "");
      for (const [open, close] of [["(", ")"], ["（", "）"], ["{", "}"]]) {
        while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -1);
      }
      const href = articleLinkUrl(raw);
      if (href) { emit({ text: raw, href }); i += raw.length; continue; }
    }
    plain += text[i++];
  }
  if (plain) parts.push({ text: plain });
  return parts;
}

export function articlePlainText(text: string, base?: string | null): string {
  return articleTextParts(text, base).map((part) => part.text).join("");
}

export function storedMarkdownLink(label: string, href: string): string {
  const escapedLabel = label.replace(/\s+/g, " ").trim().replace(/[\\\[\]]/g, "\\$&");
  const destination = href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return escapedLabel ? `[${escapedLabel}](${destination})` : "";
}
