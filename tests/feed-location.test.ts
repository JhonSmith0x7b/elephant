import assert from "node:assert/strict";
import test from "node:test";
import { articleSourceId, articleHref, feedHref, feedReturnHref, libraryHref, readFeedLocation } from "../src/lib/feed-location";

test("a feed URL restores category, source, and layout, including custom category IDs", () => {
  const location = { channel: "d42c7817-1010-4555-9391-88132c2d5a30", source: "my-source", view: "cards" as const };
  const url = new URL(feedHref(location), "https://reader.example");
  assert.deepEqual(readFeedLocation(url.searchParams), location);
  assert.deepEqual(readFeedLocation(new URLSearchParams()), { channel: "all", source: "all", view: "list" });
  assert.equal(feedHref({ channel: "all", source: "all", view: "list" }), "/");
});

test("article links preserve the exact filtered return destination", () => {
  const from = "/?channel=literature&source=lit-hub&layout=cards";
  const url = new URL(articleHref("article-id", from), "https://reader.example");
  assert.equal(url.pathname, "/articles/article-id");
  assert.equal(feedReturnHref(url.searchParams.get("from")), from);
  assert.equal(url.searchParams.get("view"), null);
  assert.equal(articleHref("article-id"), "/articles/article-id");
});

test("article requests carry the restored category and source but ignore visual layout", () => {
  const scope = readFeedLocation(new URLSearchParams("channel=literature&source=lit-hub&layout=cards"));
  assert.equal(libraryHref(scope), "/api/library?channel=literature&source=lit-hub");
  const listScope = { ...scope, view: "list" as const };
  assert.equal(libraryHref(listScope), libraryHref(scope));
  assert.equal(libraryHref({ channel: "all", source: "all" }), "/api/library");
});

test("return destinations cannot escape the feed or introduce executable URLs", () => {
  for (const value of [undefined, ["/?channel=literature"], "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/login", "/?channel=" + "a".repeat(1024)]) {
    assert.equal(feedReturnHref(value), "/");
  }
  assert.equal(feedReturnHref("/?channel=literature&layout=unknown&redirect=https://evil.example"), "/?channel=literature");
});


test("article links retain content source independently of return filters and accept old filtered links", () => {
  const source = "11f56df3-1c78-4482-9f96-d5b7a5fdc3d4";
  const url = new URL(articleHref("article-id", "/?channel=literature", source), "https://reader.example");
  assert.equal(articleSourceId(url.searchParams.get("source")), source);
  assert.equal(feedReturnHref(url.searchParams.get("from")), "/?channel=literature");
  assert.equal(articleSourceId(undefined, `/?channel=literature&source=${source}`), source);
  assert.equal(articleSourceId("invalid"), undefined);
  assert.equal(articleSourceId([source]), undefined);
  assert.equal(articleSourceId(undefined, `https://evil.example/?source=${source}`), undefined);
});
