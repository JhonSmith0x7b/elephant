import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeArticleUrl, parseFeed, RssError } from "../src/lib/rss/index";
import { isPublicAddress, resolvePublicTarget, validateFeedUrl } from "../src/lib/rss/fetch";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("36kr canonical links ignore RSS attribution without merging unrelated hosts or article parameters", () => {
  assert.equal(normalizeArticleUrl("http://36kr.com/p/12345/?f=rss&utm_source=reader#top"),
    "https://www.36kr.com/p/12345");
  assert.equal(normalizeArticleUrl("https://www.36kr.com/newsflashes/12345?f=rss"),
    "https://www.36kr.com/newsflashes/12345");
  assert.notEqual(normalizeArticleUrl("https://36kr.com/p/12345?edition=2"),
    normalizeArticleUrl("https://36kr.com/p/12345?edition=1"));
  assert.equal(normalizeArticleUrl("https://example.com/p/12345?f=rss"), "https://example.com/p/12345?f=rss");
  assert.notEqual(normalizeArticleUrl("https://www.example.com/story"), normalizeArticleUrl("https://example.com/story"));
});

test("RSS 2.0 preserves attribution and original URL, while returning plain text and images", () => {
  const feed = parseFeed(fixture("rss2.xml"), "https://example.com/feed/");
  assert.equal(feed.title, "Literary Test & Review");
  assert.equal(feed.description, "Books and people");
  assert.equal(feed.language, "en-US");
  assert.equal(feed.items.length, 4);
  const item = feed.items[0];
  assert.equal(item.externalId, "post-42");
  assert.equal(item.idKind, "guid");
  assert.equal(item.url, "https://example.com/story?utm_source=rss&edition=2#comments");
  assert.equal(item.author, "Sample Author");
  assert.equal(item.title, "A book & a conversation");
  assert.equal(item.publishedAt, "2026-10-08T10:20:00.000Z");
  assert.equal(item.summary, "Read “closely”.");
  assert.equal(item.content, "First paragraph.\n\nSecond paragraph & text.");
  assert.equal(item.contentKind, "rss_content");
  assert.equal(item.imageUrl, "https://example.com/cover.jpg");
  assert.doesNotMatch(JSON.stringify([item.summary, item.content]), /steal|display:none|<script/i);
});

test("Unknown dates remain null and fallback identity is deterministic", () => {
  const feed = parseFeed(fixture("rss2.xml"), "https://example.com/feed/");
  assert.equal(feed.items[1].publishedAt, null);
  assert.equal(feed.items[1].url, null);
  assert.equal(feed.items[1].imageUrl, "https://example.com/thumb.webp");
  assert.equal(feed.items[2].idKind, "url");
  assert.equal(feed.items[2].externalId, "https://example.com/another?a=1&b=2");
  assert.equal(feed.items[2].imageUrl, "https://example.com/enclosure.jpg");
  assert.equal(feed.items[3].idKind, "hash");
  assert.equal(feed.items[3].imageUrl, null);
  assert.equal(feed.items[3].externalId, parseFeed(fixture("rss2.xml"), "https://example.com/feed/").items[3].externalId);
});

test("Atom uses alternate links, Atom IDs, author names, XHTML and separate update times", () => {
  const feed = parseFeed(fixture("atom.xml"), "https://example.com/feed.xml");
  assert.equal(feed.language, "ja");
  assert.equal(feed.siteUrl, "https://example.com/journal/");
  assert.equal(feed.items[0].externalId, "tag:example.com,2026:entry-1");
  assert.equal(feed.items[0].url, "https://example.com/journal/entries/1");
  assert.equal(feed.items[0].author, "山田");
  assert.equal(feed.items[0].publishedAt, "2026-10-08T09:20:00.000Z");
  assert.equal(feed.items[0].updatedAt, "2026-10-09T10:00:00.000Z");
  assert.equal(feed.items[0].summary, "A short introduction.");
  assert.equal(feed.items[0].contentKind, "rss_content");
  assert.equal(feed.items[0].imageUrl, "https://example.com/color.jpg");
  assert.equal(feed.items[1].publishedAt, null);
  assert.equal(feed.items[1].author, "Editorial Team");
  assert.equal(feed.items[1].imageUrl, "https://example.com/xhtml.jpg");
  assert.equal(feed.items[1].content, "Nested text");
  assert.equal(feed.items[2].content, "First bold words.");
  assert.equal(feed.items[2].imageUrl, "https://example.com/encoded.jpg");
});

test("Parser bounds feed size and article count while preserving the full reading text", () => {
  const item = "<item><title>Book</title><description>Short</description></item>";
  const feed = parseFeed(`<rss><channel><title>Books</title>${item.repeat(151)}</channel></rss>`, "https://example.com/feed");
  assert.equal(feed.items.length, 150);
  const expected = `${"a".repeat(31_000)}\n\nThe final paragraph & its ending.`;
  const long = parseFeed(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Books</title><item><content:encoded><![CDATA[<p>${"a".repeat(31_000)}</p><p>The final <strong>paragraph</strong> &amp; its ending.</p><script>steal()</script>]]></content:encoded></item></channel></rss>`, "https://example.com/feed");
  assert.equal(long.items[0].content, expected);
  assert.equal(long.items[0].contentKind, "rss_content");
  assert.equal(long.items[0].summary?.length, 1200);
  assert.throws(() => parseFeed("a".repeat(2 * 1024 * 1024 + 1), "https://example.com/feed"), (error) => error instanceof RssError && error.code === "TOO_LARGE");
});

test("Description fallback retains complete paragraphs as safe text and labels missing content", () => {
  const expected = `Opening paragraph.\n\n${"b".repeat(31_000)}\n\nThe ending.`;
  const description = `<p>Opening <em>paragraph</em>.</p><p>${"b".repeat(31_000)}</p><p>The ending.</p><script>steal()</script><style>body{display:none}</style><iframe>hidden</iframe>`;
  const rss = parseFeed(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Books</title><item><description><![CDATA[${description}]]></description></item><item><content:encoded><![CDATA[<script>steal()</script>]]></content:encoded><description><![CDATA[<p>Safe fallback.</p>]]></description></item><item><title>Empty article</title></item></channel></rss>`, "https://example.com/feed");
  assert.equal(rss.items[0].content, expected);
  assert.equal(rss.items[0].contentKind, "rss_description");
  assert.equal(rss.items[0].summary?.length, 1200);
  assert.equal(rss.items[1].content, "Safe fallback.");
  assert.equal(rss.items[1].contentKind, "rss_description");
  assert.equal(rss.items[2].content, null);
  assert.equal(rss.items[2].contentKind, "rss_description");
  assert.doesNotMatch(rss.items[0].content ?? "", /steal|display:none|hidden|<\/?[a-z]/i);

  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Books</title><entry><id>summary-only</id><summary type="html"><![CDATA[${description}]]></summary></entry></feed>`, "https://example.com/feed");
  assert.equal(atom.items[0].content, expected);
  assert.equal(atom.items[0].contentKind, "rss_description");
  assert.equal(atom.items[0].summary?.length, 1200);
});

test("Malformed XML, regular HTML and entity declarations produce actionable errors", () => {
  assert.throws(() => parseFeed("<rss><channel></rss>", "https://example.com/feed/"), (error) => error instanceof RssError && error.code === "INVALID_XML");
  assert.throws(() => parseFeed("<html><body>Site home</body></html>", "https://example.com/"), (error) => error instanceof RssError && error.code === "NOT_A_FEED");
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>', "https://example.com/feed/"), (error) => error instanceof RssError && error.code === "INVALID_XML");
});

test("HTTP 200 browser verification HTML is reported as blocked access, not malformed XML", () => {
  const html = '<!DOCTYPE html><html lang="en"><head><style>body { color: red; }</style></head><body><p>火山引擎</p><p>正在进行安全检测...</p><p>为保障您的访问安全，系统正在检测当前网络环境</p></body></html>';
  assert.throws(() => parseFeed(html, "https://36kr.com/feed"), (error) =>
    error instanceof RssError && error.code === "ACCESS_CHALLENGE" && error.status === 502 && /安全验证页面/.test(error.message));
  assert.throws(() => parseFeed('\uFEFF <?xml version="1.0"?><!-- server message -->\n<!DOCTYPE HTML><html><body>Checking your browser</body></html>', "https://example.com/feed"), (error) =>
    error instanceof RssError && error.code === "ACCESS_CHALLENGE");
  assert.throws(() => parseFeed('<!DOCTYPE html><html><body>Site home</body></html>', "https://example.com/feed"), (error) =>
    error instanceof RssError && error.code === "NOT_A_FEED");
});

test("verification words or an embedded HTML document inside RSS are not mistaken for a blocked response", () => {
  const feed = parseFeed('<rss><channel><title>安全资讯</title><item><title>正在进行安全检测</title><description><![CDATA[<html><body><p>Checking your browser</p></body></html>]]></description></item></channel></rss>', "https://example.com/feed");
  assert.equal(feed.items[0].title, "正在进行安全检测");
  assert.equal(feed.items[0].content, "Checking your browser");
});

test("URL normalization only removes fragments and recognized tracking parameters", () => {
  assert.equal(normalizeArticleUrl("https://example.com/a?utm_source=rss&chapter=2&fbclid=abc#note"), "https://example.com/a?chapter=2");
  assert.equal(normalizeArticleUrl("javascript:alert(1)"), null);
});

test("SSRF rejects private, loopback, link-local, reserved and alternate IP spellings", (t) => {
  const hosts = process.env.RSS_LOCAL_FEED_HOSTS;
  delete process.env.RSS_LOCAL_FEED_HOSTS;
  t.after(() => {
    if (hosts === undefined) delete process.env.RSS_LOCAL_FEED_HOSTS;
    else process.env.RSS_LOCAL_FEED_HOSTS = hosts;
  });
  for (const url of [
    "file:///etc/passwd", "http://localhost/rss", "http://127.0.0.1/feed", "http://127.1/",
    "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/", "http://172.20.0.1/",
    "http://192.168.1.1/", "http://169.254.169.254/", "http://100.100.100.200/",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/",
    "https://user:password@example.com/feed", "http://reader.internal/rss",
  ]) assert.throws(() => validateFeedUrl(url), RssError, url);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(isPublicAddress("224.0.0.1"), false);
});

test("DNS validation rejects mixed or private answers and returns the exact connection address", async () => {
  await assert.rejects(resolvePublicTarget("https://example.com/rss", async () => [
    { address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]), (error) => error instanceof RssError && error.code === "UNSAFE_URL");
  await assert.rejects(resolvePublicTarget("https://example.com/rss", async () => [
    { address: "169.254.169.254", family: 4 },
  ]), RssError);
  const target = await resolvePublicTarget("https://example.com/rss", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(target.address, "8.8.8.8");
  assert.equal(target.hostname, "example.com");
  assert.equal(target.family, 4);
});
