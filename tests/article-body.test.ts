import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ArticleBody from "../src/components/article-body";
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
