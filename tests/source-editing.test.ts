import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getPool } from "../src/lib/db";
import {
  confirmImport, createPreview, deleteSource, getSource, getStoredArticle, importFetchedFeed,
  LibraryError, listLibrary, recordSourceFailure, setArticleBookmark, setArticleRead, updateSource,
} from "../src/lib/library";
import { PATCH } from "../src/app/api/feeds/[id]/route";
import type { ParsedFeed } from "../src/lib/rss/types";

const originalEnv = { ...process.env };
const schemaName = `rss_edit_test_${randomUUID().replaceAll("-", "")}`;
function feed(): ParsedFeed {
  const key = randomUUID();
  return {
    url: `https://example.com/${key}/feed`, title: "Edit test", description: null,
    siteUrl: "https://example.com/", language: "en",
    items: [{ externalId: key, idKind: "guid", url: `https://example.com/articles/${key}`,
      title: "Saved story", content: "Saved body.", contentKind: "rss_content", summary: "Summary.",
      author: null, imageUrl: null, publishedAt: null, updatedAt: null }],
  };
}

describe("editing RSS sources in an isolated PostgreSQL schema", { skip: !originalEnv.DATABASE_URL }, () => {
  let admin: Pool;
  before(async () => {
    admin = new Pool({ connectionString: originalEnv.DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const url = new URL(originalEnv.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = url.toString();
    await migrate(getPool());
  });
  after(async () => {
    await getPool().end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env = originalEnv;
  });

  it("edits in place without fetching, retaining snapshots, bookmarks and read state", async () => {
    const data = feed();
    const { sourceId } = await confirmImport(await createPreview(data), "Original", "literature");
    const article = (await listLibrary({ source: sourceId })).articles[0];
    await setArticleRead(article.id, true);
    await setArticleBookmark(article.id, true);
    const saved = (await getStoredArticle(article.id))!;
    await recordSourceFailure(sourceId, "Old feed failed");
    // .invalid cannot resolve: editing must not depend on upstream availability.
    const feedUrl = `https://new.example.invalid/${randomUUID()}/feed?token=unchanged`;
    const updated = await updateSource(sourceId, { name: " New name ", feedUrl: `${feedUrl}#fragment`, channel: "anime" });
    assert.equal(updated.id, sourceId);
    assert.equal(updated.feedUrl, feedUrl);
    assert.equal(updated.name, "New name");
    assert.equal(updated.channel, "anime");
    assert.equal(updated.lastError, null);
    assert.equal(updated.lastFetchedAt, null);
    const after = (await getStoredArticle(article.id))!;
    assert.deepEqual(after.version, saved.version);
    assert.equal(after.readAt, saved.readAt);
    assert.equal(after.bookmarkedAt, saved.bookmarkedAt);
    assert.equal(after.sourceId, sourceId);
    assert.equal((await listLibrary({ source: sourceId })).articles.length, 1);

    await assert.rejects(importFetchedFeed(sourceId, data, data.url), (error: unknown) =>
      error instanceof LibraryError && error.code === "SOURCE_CHANGED");
    await recordSourceFailure(sourceId, "Stale fetch failure", data.url);
    assert.equal((await getSource(sourceId))!.lastError, null);
    // The response may redirect; compare the requested URL, not response URL.
    const refreshed = await importFetchedFeed(sourceId, data, feedUrl);
    assert.equal(refreshed.insertedCount, 0);
    assert.equal((await getSource(sourceId))!.feedUrl, feedUrl);
    const fetchedAt = (await getSource(sourceId))!.lastFetchedAt;
    await updateSource(sourceId, { channel: "world" });
    assert.equal((await getSource(sourceId))!.lastFetchedAt, fetchedAt);
  });

  it("rejects unsafe URLs, duplicate URLs and invalid edits atomically", async () => {
    const first = await confirmImport(await createPreview(feed()), "First", "world");
    const otherFeed = feed();
    const other = await confirmImport(await createPreview(otherFeed), "Other", "anime");
    const original = await getSource(first.sourceId);
    for (const changes of [
      {}, { name: " " }, { name: "x".repeat(121) }, { channel: "missing" },
      { feedUrl: "file:///etc/passwd" }, { feedUrl: "http://169.254.169.254/latest" },
      { feedUrl: "https://user:password@example.com/feed" },
    ]) {
      await assert.rejects(updateSource(first.sourceId, changes));
      assert.deepEqual(await getSource(first.sourceId), original);
    }
    await assert.rejects(updateSource(first.sourceId, { name: "Changed", feedUrl: otherFeed.url }),
      (error: unknown) => error instanceof LibraryError && error.code === "SOURCE_EXISTS");
    assert.deepEqual(await getSource(first.sourceId), original);
    await deleteSource(other.sourceId);
    await assert.rejects(updateSource(first.sourceId, { feedUrl: otherFeed.url }),
      (error: unknown) => error instanceof LibraryError && error.code === "SOURCE_EXISTS");
    await assert.rejects(updateSource(other.sourceId, { name: "Deleted" }),
      (error: unknown) => error instanceof LibraryError && error.status === 404);
    await assert.rejects(updateSource(randomUUID(), { name: "Missing" }),
      (error: unknown) => error instanceof LibraryError && error.status === 404);
  });

  it("authorizes PATCH and retains channel-only compatibility", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.LOCAL_DEV_AUTH_BYPASS = "1";
    delete process.env.VERCEL;
    const { sourceId } = await confirmImport(await createPreview(feed()), "Route test", "world");
    const url = `http://127.0.0.1:3000/api/feeds/${sourceId}`;
    const context = { params: Promise.resolve({ id: sourceId }) };
    const request = (body: unknown, origin = "http://127.0.0.1:3000") => new Request(url, {
      method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await PATCH(request({ name: "Denied" }, "https://foreign.example"), context)).status, 403);
    for (const body of [{}, { name: 42 }, { channel: "" }, { unknown: true }]) {
      assert.equal((await PATCH(request(body), context)).status, 400);
    }
    const response = await PATCH(request({ name: "Edited", feedUrl: "https://example.invalid/feed", channel: "anime" }), context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json()).source.name, "Edited");
    const channelOnly = await PATCH(request({ channel: "literature" }), context);
    assert.equal(channelOnly.status, 200);
    const source = (await channelOnly.json()).source;
    assert.equal(source.name, "Edited");
    assert.equal(source.feedUrl, "https://example.invalid/feed");
    assert.equal(source.channel, "literature");
  });
});
