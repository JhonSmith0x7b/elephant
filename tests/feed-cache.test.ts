import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { LibraryArticle, LibraryData } from "../src/lib/contracts";
import {
  applyPendingLibrary, clearLibraryCache, getArticleStateRevision, getCachedLibrary,
  invalidateOtherLibraries, patchCachedArticle, receiveLibrary, subscribeLibraryCache,
} from "../src/lib/feed-cache";

function article(id: string, extra: Partial<LibraryArticle> = {}): LibraryArticle {
  return {
    id, sourceId: "source", sourceIds: ["source"], sourceName: "Source",
    title: id, url: `https://example.com/${id}`, summary: "summary", imageUrl: null,
    author: null, publishedAt: null, firstSeenAt: "2026-10-09", channel: "world",
    channelName: "World", readAt: null, bookmarkedAt: null, ...extra,
  };
}
function library(articles: LibraryArticle[]): LibraryData {
  return { channels: [], sources: [], articles, articleCount: articles.length,
    counts: { sources: 1, articles: articles.length, bookmarks: 0 } };
}
beforeEach(clearLibraryCache);

test("scopes retain independent stable snapshots", () => {
  receiveLibrary("all", library([article("a")]));
  const initial = getCachedLibrary("all");
  receiveLibrary("world", library([article("b")]));
  assert.equal(getCachedLibrary("all"), initial);
  assert.equal(getCachedLibrary("world")?.data.articles[0].id, "b");
  assert.equal(getCachedLibrary("missing"), null);
});

test("new content waits for acknowledgement while metadata updates", () => {
  receiveLibrary("all", library([article("a")]));
  receiveLibrary("all", library([article("b"), article("a")]));
  assert.deepEqual(getCachedLibrary("all")?.data.articles.map(a => a.id), ["a"]);
  assert.equal(getCachedLibrary("all")?.data.counts.articles, 2);
  assert.equal(getCachedLibrary("all")?.newCount, 1);
  applyPendingLibrary("all");
  assert.deepEqual(getCachedLibrary("all")?.data.articles.map(a => a.id), ["b", "a"]);
  assert.equal(getCachedLibrary("all")?.pending, null);
});

test("state-only updates never show new content; edits and reorder do", () => {
  receiveLibrary("all", library([article("a"), article("b")]));
  receiveLibrary("all", library([article("a", { readAt: "today" }), article("b")]));
  assert.equal(getCachedLibrary("all")?.pending, null);
  assert.equal(getCachedLibrary("all")?.data.articles[0].readAt, "today");
  receiveLibrary("all", library([article("b"), article("a", { title: "edited" })]));
  assert.ok(getCachedLibrary("all")?.pending);
  assert.equal(getCachedLibrary("all")?.newCount, 0);
});

test("read and bookmark mutations patch all scopes and pending snapshots", () => {
  receiveLibrary("all", library([article("a")]));
  receiveLibrary("world", library([article("a")]));
  receiveLibrary("all", library([article("b"), article("a")]));
  patchCachedArticle("a", { readAt: "read", bookmarkedAt: "saved" });
  assert.equal(getCachedLibrary("world")?.data.articles[0].bookmarkedAt, "saved");
  assert.equal(getCachedLibrary("all")?.data.articles[0].readAt, "read");
  applyPendingLibrary("all");
  assert.equal(getCachedLibrary("all")?.data.articles[1].bookmarkedAt, "saved");
  assert.equal(getCachedLibrary("all")?.data.counts.bookmarks, 1);
});

test("GET started before a mutation cannot overwrite its state", () => {
  receiveLibrary("all", library([article("a")]));
  const requestRevision = getArticleStateRevision();
  patchCachedArticle("a", { readAt: "read", bookmarkedAt: "saved" });
  receiveLibrary("all", library([article("a")]), false, requestRevision);
  assert.equal(getCachedLibrary("all")?.data.articles[0].readAt, "read");
  assert.equal(getCachedLibrary("all")?.data.articles[0].bookmarkedAt, "saved");
  receiveLibrary("all", library([article("a")]), false, getArticleStateRevision());
  assert.equal(getCachedLibrary("all")?.data.articles[0].bookmarkedAt, null);
});

test("forced refresh, invalidation, subscriptions and cache bounds", () => {
  let notifications = 0;
  const unsubscribe = subscribeLibraryCache(() => { notifications += 1; });
  receiveLibrary("all", library([article("a")]));
  receiveLibrary("all", library([article("b")]), true);
  assert.equal(getCachedLibrary("all")?.data.articles[0].id, "b");
  for (let index = 0; index < 20; index++) receiveLibrary(`scope-${index}`, library([]));
  assert.equal(getCachedLibrary("all"), null);
  invalidateOtherLibraries("scope-19");
  assert.equal(getCachedLibrary("scope-18"), null);
  assert.ok(getCachedLibrary("scope-19"));
  clearLibraryCache();
  assert.equal(getCachedLibrary("scope-19"), null);
  assert.ok(notifications > 0);
  unsubscribe();
});

test("bookmark totals update scopes that do not contain the article", () => {
  receiveLibrary("world", library([article("a")]));
  receiveLibrary("literature", library([article("b")]));
  patchCachedArticle("a", { bookmarkedAt: "saved" });
  assert.equal(getCachedLibrary("literature")?.data.counts.bookmarks, 1);
  patchCachedArticle("absent", { bookmarkedAt: "saved" }, { bookmarkedAt: null });
  assert.equal(getCachedLibrary("world")?.data.counts.bookmarks, 2);
  assert.equal(getCachedLibrary("literature")?.data.counts.bookmarks, 2);
});

test("old GET preserves bookmark total even outside scope and never double counts", () => {
  receiveLibrary("world", library([article("a")]));
  const revision = getArticleStateRevision();
  patchCachedArticle("a", { bookmarkedAt: "saved" });
  receiveLibrary("literature", library([article("b")]), false, revision);
  assert.equal(getCachedLibrary("literature")?.data.counts.bookmarks, 1);
  const serverAlreadyUpdated = library([article("b")]);
  serverAlreadyUpdated.counts.bookmarks = 1;
  receiveLibrary("literature", serverAlreadyUpdated, false, revision);
  assert.equal(getCachedLibrary("literature")?.data.counts.bookmarks, 1);
});

test("configuration invalidation forces next normal response to replace displayed data", () => {
  receiveLibrary("all", library([article("a")]));
  invalidateOtherLibraries("all");
  receiveLibrary("all", library([article("b")]));
  assert.equal(getCachedLibrary("all")?.data.articles[0].id, "b");
  assert.equal(getCachedLibrary("all")?.pending, null);
  receiveLibrary("all", library([article("c")]));
  assert.ok(getCachedLibrary("all")?.pending);
});

test("article count changes outside visible page remain pending across polls", () => {
  receiveLibrary("all", library([article("a")]));
  const next = { ...library([article("a")]), articleCount: 2 };
  receiveLibrary("all", next);
  assert.equal(getCachedLibrary("all")?.data.articleCount, 1);
  assert.equal(getCachedLibrary("all")?.pending?.articleCount, 2);
  receiveLibrary("all", next);
  assert.equal(getCachedLibrary("all")?.pending?.articleCount, 2);
  applyPendingLibrary("all");
  assert.equal(getCachedLibrary("all")?.data.articleCount, 2);
});

test("a fresh server state supersedes an older local bookmark mutation baseline", () => {
  receiveLibrary("all", library([article("a")]));
  patchCachedArticle("a", { bookmarkedAt: "saved" });
  receiveLibrary("all", library([article("a")]));
  patchCachedArticle("a", { bookmarkedAt: "saved-again" }, { bookmarkedAt: null });
  assert.equal(getCachedLibrary("all")?.data.counts.bookmarks, 1);
});
