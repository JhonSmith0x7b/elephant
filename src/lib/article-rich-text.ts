import { Parser } from "htmlparser2";
import { articleLinkUrl, articlePlainText } from "./article-links";

export type RichTextTag = "p" | "div" | "h2" | "h3" | "h4" | "h5" | "h6" | "strong" | "em" | "s" | "sub" | "sup" | "blockquote" | "ul" | "ol" | "li" | "br" | "hr" | "figure" | "figcaption" | "img" | "a" | "table" | "thead" | "tbody" | "tfoot" | "tr" | "th" | "td" | "caption" | "pre" | "code";
export type ArticleRichTextNode = { type: "text"; text: string } | {
  type: "element"; tag: RichTextTag; attributes: Record<string, string>; children: ArticleRichTextNode[];
};
const allowed = new Set<string>(["p", "div", "h2", "h3", "h4", "h5", "h6", "strong", "em", "s", "sub", "sup", "blockquote", "ul", "ol", "li", "br", "hr", "figure", "figcaption", "img", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "pre", "code"]);
const blocked = new Set(["script", "style", "noscript", "iframe", "svg", "math", "template", "object", "embed", "form", "input", "button", "select", "textarea", "head"]);
const aliases: Record<string, string> = { h1: "h2", b: "strong", i: "em", strike: "s", section: "div", article: "div" };
const blocks = new Set(["p", "div", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "caption", "pre"]);
const voidTags = new Set(["img", "br", "hr"]);
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A restricted, style-free document tree. Unknown wrappers are unwrapped;
 * executable/foreign content is removed, not passed to HTML or React renderers. */
export function articleRichTextNodes(input: string, base?: string | null, allowImageUrl?: (url: string) => boolean): ArticleRichTextNode[] {
  const root: ArticleRichTextNode[] = [];
  const stack: (ArticleRichTextNode[] | null)[] = [root];
  const parser = new Parser({
    onopentag(name, attributes) {
      const parent = stack[stack.length - 1];
      if (!parent || blocked.has(name) || stack.length > 64) { stack.push(null); return; }
      const tag = aliases[name] ?? name;
      if (!allowed.has(tag)) { stack.push(parent); return; }
      const safe: Record<string, string> = {};
      if (tag === "a") {
        const href = articleLinkUrl(attributes.href ?? "", base);
        if (!href) { stack.push(parent); return; }
        safe.href = href;
      }
      if (tag === "img") {
        const src = [attributes["data-src"], attributes["data-original"], attributes["data-lazy-src"], attributes.src]
          .map(value => articleLinkUrl(value ?? "", base)).find(value => value && (!allowImageUrl || allowImageUrl(value)));
        if (!src) { stack.push(null); return; }
        safe.src = src;
        safe.alt = attributes.alt?.trim() || "";
      }
      for (const key of tag === "ol" ? ["start"] : ["td", "th"].includes(tag) ? ["colspan", "rowspan"] : []) {
        const value = attributes[key];
        if (value && /^\d{1,4}$/.test(value) && Number(value) > 0) safe[key] = String(Number(value));
      }
      const element: ArticleRichTextNode = { type: "element", tag: tag as RichTextTag, attributes: safe, children: [] };
      parent.push(element);
      stack.push(element.children);
    },
    ontext(text) {
      const parent = stack[stack.length - 1];
      if (parent) parent.push({ type: "text", text });
    },
    onclosetag() { if (stack.length > 1) stack.pop(); },
  }, { decodeEntities: true });
  parser.end(input);
  return normalizeContext(normalize(root));
}

function normalize(nodes: ArticleRichTextNode[], inAnchor = false): ArticleRichTextNode[] {
  return nodes.flatMap(node => {
    if (node.type === "text") return [node];
    node.children = normalize(node.children, inAnchor || node.tag === "a");
    if (node.tag === "a" && inAnchor) return node.children;
    // Keep the stored tree equal to the browser's table tree (which otherwise
    // inserts tbody or moves invalid table children outside their parent).
    const permitted = node.tag === "table" ? new Set(["caption", "thead", "tbody", "tfoot", "tr"])
      : ["thead", "tbody", "tfoot"].includes(node.tag) ? new Set(["tr"])
        : node.tag === "tr" ? new Set(["td", "th"]) : null;
    if (permitted && node.children.some(child => child.type === "text" ? !!child.text.trim() : !permitted.has(child.tag))) {
      node.tag = "div";
    } else if (node.tag === "table") {
      const children: ArticleRichTextNode[] = [];
      let rowGroup: Extract<ArticleRichTextNode, { type: "element" }> | null = null;
      for (const child of node.children) {
        if (child.type === "element" && child.tag === "tr") {
          if (!rowGroup) { rowGroup = { type: "element", tag: "tbody", attributes: {}, children: [] }; children.push(rowGroup); }
          rowGroup.children.push(child);
        } else {
          rowGroup = null;
          children.push(child);
        }
      }
      node.children = children;
    }
    if (node.tag === "p" && node.children.some(child => child.type === "element" && blocks.has(child.tag))) node.tag = "div";
    return [node];
  });
}

// Once an invalid table wrapper becomes a div, descendants must be normalized
// against their new parent too; otherwise browsers discard/foster orphan cells.
function normalizeContext(nodes: ArticleRichTextNode[], parent?: RichTextTag): ArticleRichTextNode[] {
  for (const node of nodes) {
    if (node.type === "text") continue;
    const orphan = ["thead", "tbody", "tfoot", "caption"].includes(node.tag) ? parent !== "table"
      : node.tag === "tr" ? !parent || !["thead", "tbody", "tfoot"].includes(parent)
        : ["td", "th"].includes(node.tag) ? parent !== "tr" : false;
    if (orphan) { node.tag = "div"; node.attributes = {}; }
    node.children = normalizeContext(node.children, node.tag);
    // Transparent/inline wrappers such as anchors can hide blocks several
    // levels down. A paragraph cannot contain those blocks at any depth.
    if (node.tag === "p" && containsBlock(node.children)) node.tag = "div";
  }
  return nodes;
}

function containsBlock(nodes: ArticleRichTextNode[]): boolean {
  return nodes.some(node => node.type === "element" &&
    (blocks.has(node.tag) || node.tag === "hr" || containsBlock(node.children)));
}

export function sanitizeArticleHtml(input: string, base?: string | null, allowImageUrl?: (url: string) => boolean): { html: string; text: string; imageUrl: string | null } {
  const nodes = articleRichTextNodes(input, base, allowImageUrl);
  let imageUrl: string | null = null;
  const text: string[] = [];
  const serialize = (items: ArticleRichTextNode[]): string => items.map(node => {
    if (node.type === "text") { text.push(node.text); return escapeText(node.text); }
    if (blocks.has(node.tag) || node.tag === "br" || node.tag === "hr") text.push("\n");
    if (node.tag === "td" || node.tag === "th") text.push("\t");
    if (node.tag === "img") { imageUrl ??= node.attributes.src; text.push("\n"); }
    const attributes = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${escapeText(value)}"`).join("");
    const body = serialize(node.children);
    if (blocks.has(node.tag)) text.push("\n");
    return `<${node.tag}${attributes}>${body}${voidTags.has(node.tag) ? "" : `</${node.tag}>`}`;
  }).join("");
  const html = serialize(nodes).trim();
  return {
    html,
    text: articlePlainText(text.join("").replace(/[\t\r\f\v \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(), base),
    imageUrl,
  };
}
