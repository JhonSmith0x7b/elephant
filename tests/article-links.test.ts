import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ArticleLinks from "../src/components/article-links";
import { articleTextParts, storedMarkdownLink } from "../src/lib/article-links";
import { parseFeed } from "../src/lib/rss/parse";

const base = "https://example.com/books/story";
const feed = (body: string) => parseFeed(`<rss version="2.0"><channel><title>Test</title><item><title>News</title><link>${base}</link><description><![CDATA[${body}]]></description></item></channel></rss>`, "https://example.com/feed").items[0];

test("RSS preserves HTML link destinations and nested labels in body, with plain list summaries", () => {
  const item = feed('<p>Read <a href="../review?q=book&amp;edition=2"><strong>A [great]</strong> review</a>.</p><p>Next paragraph.</p>');
  assert.equal(item.summary, "Read A [great] review.\n\nNext paragraph.");
  assert.equal(item.content, "Read [A \\[great\\] review](https://example.com/review?q=book&edition=2).\n\nNext paragraph.");
  assert.deepEqual(articleTextParts(item.content!), [
    { text: "Read " }, { text: "A [great] review", href: "https://example.com/review?q=book&edition=2" }, { text: ".\n\nNext paragraph." },
  ]);
});

test("Markdown feeds retain clickable labels while summaries omit Markdown destinations", () => {
  const item = feed('读 [书评](../review "评论")，以及 [维基](https://example.com/Book_(novel))。');
  assert.equal(item.summary, "读 书评，以及 维基。");
  assert.deepEqual(articleTextParts(item.content!, base).filter((part) => part.href), [
    { text: "书评", href: "https://example.com/review" },
    { text: "维基", href: "https://example.com/Book_(novel)" },
  ]);
});

test("existing plain URLs become links without swallowing Chinese or sentence punctuation", () => {
  const text = "看 https://example.com/a。还有 (https://example.com/Book_(novel)).\nhttps://example.com/?a=1&b=2!";
  const parts = articleTextParts(text);
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(parts.filter((part) => part.href).map((part) => part.href), [
    "https://example.com/a", "https://example.com/Book_(novel)", "https://example.com/?a=1&b=2",
  ]);
});

test("unsafe HTML and Markdown destinations cannot create executable anchors", () => {
  const item = feed('<a href="javascript:alert(1)">one</a> <a href="data:text/html,evil">two</a><script>alert(1)</script>');
  assert.equal(item.content, "one two");
  for (const target of ["javascript:alert(1)", "data:text/html,evil", "file:///tmp/data", "https://user:password@example.com/"]) {
    assert.deepEqual(articleTextParts(`[label](${target})`, base), [{ text: "label" }]);
  }
  const html = renderToStaticMarkup(createElement(ArticleLinks, {
    text: '[<img src=x onerror=evil>](https://example.com/) [bad](javascript:alert(1))', base,
  }));
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|href="javascript:/);
});

test("link labels can wrap one line but cannot span paragraphs", () => {
  assert.deepEqual(articleTextParts('[first\nsecond](https://example.com/)'), [{ text: "first\nsecond", href: "https://example.com/" }]);
  const broken = articleTextParts('[first\n\nsecond](https://example.com/)');
  assert.equal(broken[0].text, '[first\n\nsecond](');
  const item = feed('<a href="/review"><p>first</p><p>second</p></a>');
  assert.equal(item.content, '[first second](https://example.com/review)');
});

test("stored links escape special label and destination characters without changing navigation", () => {
  const link = storedMarkdownLink('A [book] \\ B', 'https://example.com/Book_(novel)');
  const parts = articleTextParts(link);
  assert.equal(parts[0].text, 'A [book] \\ B');
  assert.equal(decodeURI(parts[0].href!), 'https://example.com/Book_(novel)');
});

test("Atom XHTML anchors survive content extraction with relative destinations", () => {
  const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><id>one</id><title>Article</title><link href="${base}"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Read <a href="../review">the review</a>.</p></div></content></entry></feed>`, "https://example.com/feed");
  assert.equal(parsed.items[0].content, "Read [the review](https://example.com/review).");
  assert.equal(parsed.items[0].summary, "Read the review.");
});
