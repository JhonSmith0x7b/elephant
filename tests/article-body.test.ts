import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ArticleBody, { articleBodyHasImage } from "../src/components/article-body";
import { articleTextParts, articlePlainText } from "../src/lib/article-links";

test("inline images retain order, escaped alt text, and HTTP-only resolved destinations", () => {
  const body = 'Before ![a \\[book\\]](../cover.jpg) after ![](https://example.com/b.png) end';
  const parts = articleTextParts(body, 'https://example.com/story/1');
  assert.deepEqual(parts.filter(p => p.image), [{text:'a [book]',href:'https://example.com/cover.jpg',image:true},{text:'',href:'https://example.com/b.png',image:true}]);
  assert.equal(articlePlainText(body, 'https://example.com/story/1'), 'Before  after  end');
  assert.equal(articleTextParts('![bad](javascript:alert(1))')[0].href, undefined);
});

test("article images render outside paragraphs and links still work with spaces preserved", () => {
  const html = renderToStaticMarkup(createElement(ArticleBody, {body:'Before ![<cover>](https://example.com/a.jpg) after\n\n[one](https://example.com/1) [two](https://example.com/2)',base:'https://example.com/'}));
  assert.match(html, /<p>Before <\/p><figure/);
  assert.match(html, /<\/figure><p> after<\/p>/);
  assert.match(html, /alt="&lt;cover&gt;"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /<\/a> <a/);
  assert.doesNotMatch(html, /<p><figure/);
  const unsafe = renderToStaticMarkup(createElement(ArticleBody, {body:'![bad](data:image/svg+xml,evil)'}));
  assert.doesNotMatch(unsafe, /<img/);
});

test("rich bodies render semantic headings, emphasis, quotes, lists, captions and safe tables", () => {
  const body = '<h1>章节</h1><p>正文<strong>重点</strong><em>书名</em></p><blockquote><p>引文</p></blockquote>'
    + '<ol start="3"><li>第三项</li><li>第四项</li></ol><figure><a href="/large"><img src="/cover.jpg" alt="封面"></a><figcaption>摄影说明</figcaption></figure>'
    + '<table><tbody><tr><th>名称</th><td colspan="2">内容</td></tr></tbody></table><pre><code>  first\n    second</code></pre>';
  const html = renderToStaticMarkup(createElement(ArticleBody, { body, format: "html", base: "https://example.com/story" }));
  assert.match(html, /<h2>章节<\/h2>/);
  assert.match(html, /<strong>重点<\/strong><em>书名<\/em>/);
  assert.match(html, /<blockquote><p>引文<\/p><\/blockquote>/);
  assert.match(html, /<ol start="3"><li>第三项<\/li>/);
  assert.match(html, /<figure><a[^>]+href="https:\/\/example.com\/large"[^>]*><img/);
  assert.match(html, /<\/a><figcaption>摄影说明<\/figcaption><\/figure>/);
  assert.equal((html.match(/<figure>/g) || []).length, 1);
  assert.match(html, /class="stored-table-scroll" role="region"/);
  assert.match(html, /<td colSpan="2">内容<\/td>/i);
  assert.match(html, /<pre><code>  first\n    second<\/code><\/pre>/);
  assert.equal(articleBodyHasImage(body, "https://example.com/cover.jpg", "https://example.com/story", "html"), true);
  assert.equal(articleBodyHasImage(body, "https://example.com/other.jpg", "https://example.com/story", "html"), false);
});

test("rich body renderer rejects executable input while preserving plain URL links without nested anchors", () => {
  const body = '<p onclick="bad()">https://example.com/one</p><a href="/two">https://example.com/two</a>'
    + '<pre>https://example.com/code</pre><script>alert(1)</script><img src="javascript:bad()" onerror="bad()">';
  const html = renderToStaticMarkup(createElement(ArticleBody, { body, format: "html", base: "https://example.com/" }));
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /<pre>https:\/\/example.com\/code<\/pre>/);
  assert.doesNotMatch(html, /onclick|onerror|javascript:|<script|alert\(1\)/);
  const legacy = renderToStaticMarkup(createElement(ArticleBody, { body: '<h2>literal</h2> **unchanged**' }));
  assert.match(legacy, /&lt;h2&gt;literal&lt;\/h2&gt; \*\*unchanged\*\*/);
  assert.doesNotMatch(legacy, /<h2>|<strong>/);
});
