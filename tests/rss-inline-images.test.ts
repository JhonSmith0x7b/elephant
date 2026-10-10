import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "../src/lib/rss/parse";

function item(body: string, description = "") {
  return parseFeed(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Test</title><item><title>Article</title><link>https://example.com/books/story</link><description><![CDATA[${description}]]></description><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`, "https://example.com/feed").items[0];
}

test("RSS stores multiple inline images in their original reading order without polluting summaries", () => {
  const parsed = item('<p>Before</p><img src="/first.jpg" alt="First"><p>Between</p><img src="/second.jpg" alt="Second"><p>After</p>');
  assert.equal(parsed.content, 'Before\n\n![First](https://example.com/first.jpg)\n\nBetween\n\n![Second](https://example.com/second.jpg)\n\nAfter');
  assert.equal(parsed.summary, 'Before\n\nBetween\n\nAfter');
  assert.equal(parsed.imageUrl, 'https://example.com/first.jpg');
  assert.equal(parsed.contentKind, 'rss_content');
});

test("lazy image sources take precedence over placeholders, resolve relative URLs and escape labels", () => {
  const parsed = item('<img src="data:image/gif;base64,placeholder" data-src="../cover_(large).jpg" alt="A [book]"><img src="/placeholder.jpg" data-original="//cdn.example.com/full.jpg"><img data-src="javascript:evil" src="/valid.jpg">');
  assert.equal(parsed.content, '![A \\[book\\]](https://example.com/cover_%28large%29.jpg)\n\n![图片](https://cdn.example.com/full.jpg)\n\n![图片](https://example.com/valid.jpg)');
  assert.equal(parsed.summary, null);
});

test("linked images remain image blocks while adjacent anchor text stays clickable", () => {
  const parsed = item('<a href="/review">Before<img src="/cover.jpg" alt="Cover">After</a><a href="/large"><img src="/photo.jpg"></a>');
  assert.equal(parsed.content, '[Before](https://example.com/review)\n\n![Cover](https://example.com/cover.jpg)\n\n[After](https://example.com/review)\n\n![图片](https://example.com/photo.jpg)');
  assert.equal(parsed.summary, 'Before\nAfter');
});

test("unsafe image schemes and ignored markup cannot enter saved image content", () => {
  const parsed = item('<img src="javascript:evil"><img src="data:image/svg+xml,evil"><img src="file:///secret"><img src="https://user:pass@example.com/a.jpg"><script><img src="https://example.com/script.jpg"></script><noscript><img src="https://example.com/noscript.jpg"></noscript><p>Safe</p>');
  assert.equal(parsed.content, 'Safe');
  assert.equal(parsed.imageUrl, null);
});

test("image-only full content wins over a text summary and retains its full-content kind", () => {
  const parsed = item('<img src="/art.jpg">', 'A summary');
  assert.equal(parsed.content, '![图片](https://example.com/art.jpg)');
  assert.equal(parsed.summary, 'A summary');
  assert.equal(parsed.contentKind, 'rss_content');
});

test("Atom XHTML inline images survive in reading order", () => {
  const parsed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><id>one</id><title>Article</title><link href="https://example.com/story"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Before</p><img src="/art.jpg" alt="Art"/><p>After</p></div></content></entry></feed>', 'https://example.com/feed').items[0];
  assert.equal(parsed.content, 'Before\n\n![Art](https://example.com/art.jpg)\n\nAfter');
  assert.equal(parsed.summary, 'Before\n\nAfter');
});

test("anonymous image-only articles receive distinct fallback identities", () => {
  const parsed = parseFeed('<rss version="2.0"><channel><title>Test</title><item><description><![CDATA[<img src="https://example.com/one.jpg">]]></description></item><item><description><![CDATA[<img src="https://example.com/two.jpg">]]></description></item></channel></rss>', 'https://example.com/feed');
  assert.notEqual(parsed.items[0].externalId, parsed.items[1].externalId);
});
