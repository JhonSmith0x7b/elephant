import assert from "node:assert/strict";
import { test } from "node:test";
import { articleRichTextNodes, sanitizeArticleHtml } from "../src/lib/article-rich-text";
import { parseFeed } from "../src/lib/rss/parse";

const base = "https://example.com/articles/story";

test("rich text keeps hierarchy, emphasis, lists, captions, tables and code whitespace", () => {
  const source = '<h1>Heading</h1><p>A <b>bold</b> and <i>italic</i> sentence.</p><blockquote>Quote</blockquote><ol start="3"><li>First</li><li>Second</li></ol><figure><img src="../cover.jpg" alt="Cover"><figcaption>Real caption</figcaption></figure><table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table><pre><code>  first\n    second &lt; 3</code></pre>';
  const result = sanitizeArticleHtml(source, base);
  assert.match(result.html, /^<h2>Heading<\/h2>/);
  assert.match(result.html, /<strong>bold<\/strong> and <em>italic<\/em>/);
  assert.match(result.html, /<blockquote>Quote<\/blockquote><ol start="3"><li>First<\/li><li>Second<\/li><\/ol>/);
  assert.match(result.html, /<figure><img src="https:\/\/example.com\/cover.jpg" alt="Cover"><figcaption>Real caption<\/figcaption><\/figure>/);
  assert.match(result.html, /<table><tbody><tr><th>A<\/th><th>B<\/th><\/tr>/);
  assert.match(result.html, /<pre><code>  first\n    second &lt; 3<\/code><\/pre>/);
  assert.match(result.text, /A B\n\nC D/);
  assert.equal(sanitizeArticleHtml(result.html, base).html, result.html);
});

test("sanitizer strips executable content, dangerous destinations and source styling", () => {
  const result = sanitizeArticleHtml('<div id="x" style="color:red" onclick="evil()"><p>Safe <a href="javascript:evil()">label</a><a href="/read" target="x" onmouseover="evil()">read</a><img src="data:image/svg+xml,evil" onerror="evil()"><img src="/photo.jpg" alt="&quot; onerror=&quot;evil()"></p><script>secret</script><iframe>hidden</iframe><svg><foreignObject><p>foreign</p></foreignObject></svg><math><mtext>foreign</mtext></math><style>secret</style><form><input value="secret">hidden</form></div>', base);
  assert.doesNotMatch(result.html, /<(script|iframe|svg|math|style|form|input)| style=| onclick=| target=| onmouseover=|src="data:|href="javascript:/);
  assert.doesNotMatch(result.text, /secret|hidden|foreign/);
  assert.match(result.html, /href="https:\/\/example.com\/read"/);
  const nodes = articleRichTextNodes(result.html, base);
  assert.ok(nodes.length);
  assert.equal(sanitizeArticleHtml(result.html, base).html, result.html, "escaped quotes cannot turn an alt into a new attribute");
});

test("malformed or deeply nested content stays bounded without executable markup", () => {
  const malformed = sanitizeArticleHtml('<table><tr><div>Layout text</div></tr></table><a href="/one">one<a href="/two">two</a></a>', base);
  assert.doesNotMatch(malformed.html, /<table>|<tr>/);
  assert.match(malformed.text, /Layout text/);
  const deep = sanitizeArticleHtml('<div>'.repeat(1000) + 'Deep' + '</div>'.repeat(1000), base);
  assert.ok(deep.html.length < 1000);
});

test("plain and Markdown feeds retain legacy interpretation; actual HTML has an explicit format", () => {
  const rss = (body: string) => parseFeed(`<rss><channel><title>Test</title><item><description><![CDATA[${body}]]></description></item></channel></rss>`, base).items[0];
  assert.equal(rss('A &amp; B\n\n[link](/read)').content, 'A & B\n\n[link](/read)');
  assert.equal(rss('A &amp; B\n\n[link](/read)').contentFormat, 'legacy');
  assert.equal(rss('<p>A <strong>strong</strong> paragraph</p>').contentFormat, 'html');
  assert.equal(rss('<p>A <strong>strong</strong> paragraph</p>').summary, 'A strong paragraph');
});

test("invalid tables normalize orphan descendants using their final parent context", () => {
  const malformed = sanitizeArticleHtml('<table><div>x</div><tr><td colspan="2">y</td></tr></table><tbody><tr><th>z</th></tr></tbody>', base);
  assert.doesNotMatch(malformed.html, /<(table|tbody|thead|tfoot|tr|td|th)\b/);
  assert.equal(malformed.text.replace(/\s/g, ''), 'xyz');
  assert.equal(sanitizeArticleHtml(malformed.html, base).html, malformed.html);
  const mixed = sanitizeArticleHtml('<table><tbody><tr><td>good</td></tr></tbody><div>bad</div></table>', base);
  assert.doesNotMatch(mixed.html, /<(table|tbody|tr|td)\b/);
  assert.equal(mixed.text.replace(/\s/g, ''), 'goodbad');
});

test("paragraphs cannot hide block elements through inline or transparent wrappers", () => {
  const input = '<p>before<a href="/read"><strong><div>inside</div></strong></a>after</p>';
  const normalized = sanitizeArticleHtml(input, base);
  const assertParagraphs = (nodes: ReturnType<typeof articleRichTextNodes>, inParagraph = false) => {
    for (const node of nodes) {
      if (node.type === 'text') continue;
      if (inParagraph) assert.ok(!['p', 'div', 'blockquote', 'figure', 'table', 'h2', 'h3'].includes(node.tag));
      assertParagraphs(node.children, inParagraph || node.tag === 'p');
    }
  };
  assertParagraphs(articleRichTextNodes(normalized.html, base));
  assert.match(normalized.text, /inside/);
  assert.equal(sanitizeArticleHtml(normalized.html, base).html, normalized.html);
});

test("anonymous items retain pre-rich-text fallback identities despite richer whitespace", () => {
  const feed = parseFeed('<rss><channel><title>Test</title><item><title>Book</title><description><![CDATA[<ul><li>First</li><li>Second</li></ul><table><tr><td>A</td><td>B</td></tr></table><figure><figcaption>Caption</figcaption></figure>]]></description></item><item><title>Image</title><description><![CDATA[<img src="/image.jpg">]]></description></item></channel></rss>', base);
  assert.equal(feed.items[0].externalId, 'c4443a82f79f92d9c253e7a1555d0cd26342345bd11f9edfd7fd87242838b799');
  assert.equal(feed.items[1].externalId, '871b24763916c86ca9d41c212b3724d69818958c4141c4ab0adb5d62057b01c9');
  assert.equal(feed.items[0].contentFormat, 'html');
  assert.match(feed.items[0].content!, /<ul><li>First<\/li>/);
});
