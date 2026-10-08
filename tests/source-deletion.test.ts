import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getPool } from "../src/lib/db";
import {
  confirmImport, createPreview, deleteSource, getSource, getStoredArticle, importFetchedFeed,
  LibraryError, listBookmarks, listLibrary, recordSourceFailure,
  setArticleBookmark, setArticleRead, updateSourceChannel,
} from "../src/lib/library";
import { DELETE } from "../src/app/api/feeds/[id]/route";
import type { ParsedFeed } from "../src/lib/rss/types";

const originalEnv = { ...process.env };
const schemaName = `rss_delete_test_${randomUUID().replaceAll("-", "")}`;

function feed(): ParsedFeed {
  const key = randomUUID();
  return {
    url: `https://example.com/${key}/feed`, title: "Delete test", description: null,
    siteUrl: "https://example.com/", language: "en",
    items: [{
      externalId: key, idKind: "guid", url: `https://example.com/articles/${key}`,
      title: "Saved story", content: "Original story.", contentKind: "rss_content",
      summary: "Summary.", author: null, imageUrl: null, publishedAt: null, updatedAt: null,
    }],
  };
}

describe("deleting RSS sources in an isolated PostgreSQL schema", { skip: !originalEnv.DATABASE_URL }, () => {
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

  it("removes the last subscription while retaining articles, versions, reads and bookmarks", async () => {
    const data = feed();
    const preview = await createPreview(data);
    const imported = await confirmImport(preview, "Original source", "literature");
    const article = (await listLibrary()).articles[0];
    await setArticleRead(article.id, true);
    await setArticleBookmark(article.id, true);
    const saved = await getStoredArticle(article.id);

    assert.deepEqual(await deleteSource(imported.sourceId), { sourceId: imported.sourceId });
    assert.deepEqual(await deleteSource(imported.sourceId), { sourceId: imported.sourceId });
    const library = await listLibrary();
    assert.equal(library.sources.length, 0);
    assert.deepEqual(library.counts, { sources: 0, articles: 1, bookmarks: 1 });
    assert.equal(library.articles[0].id, article.id);
    assert.deepEqual(await getStoredArticle(article.id), saved);
    assert.equal((await listBookmarks()).articles[0].id, article.id);
    assert.equal(await getSource(imported.sourceId), null);
    await assert.rejects(importFetchedFeed(imported.sourceId, data),
      (e: unknown) => e instanceof LibraryError && e.code === "SOURCE_NOT_FOUND");
    await assert.rejects(updateSourceChannel(imported.sourceId, "anime"),
      (e: unknown) => e instanceof LibraryError && e.code === "SOURCE_NOT_FOUND");
    await recordSourceFailure(imported.sourceId, "A fetch completed after deletion");
    assert.equal((await getPool().query("SELECT last_error FROM sources WHERE id=$1", [imported.sourceId])).rows[0].last_error, null);

    // Retrying an old confirmation must not undo a later deletion.
    assert.deepEqual(await confirmImport(preview, "Old retry", "anime"), imported);
    assert.equal(await getSource(imported.sourceId), null);
    await migrate(getPool());
    assert.equal((await listLibrary()).sources.length, 0);

    const restored = await confirmImport(await createPreview(data), "Restored source", "literature");
    assert.equal(restored.sourceId, imported.sourceId);
    assert.equal(restored.insertedCount, 0);
    assert.equal((await listLibrary()).counts.sources, 1);
    const after = (await getStoredArticle(article.id))!;
    assert.deepEqual(after.version, saved!.version);
    assert.equal(after.readAt, saved!.readAt);
    assert.equal(after.bookmarkedAt, saved!.bookmarkedAt);
  });

  it("keeps shared articles and other subscriptions intact when their original source is removed", async () => {
    const data = feed();
    const original = await confirmImport(await createPreview(data), "Primary", "world");
    const otherData = { ...data, url: `https://example.com/${randomUUID()}/feed` };
    const other = await confirmImport(await createPreview(otherData), "Secondary", "anime");
    const article = (await listLibrary()).articles.find(a => a.sourceIds.includes(original.sourceId))!;
    await deleteSource(original.sourceId);
    const library = await listLibrary();
    assert.ok(library.sources.some(s => s.id === other.sourceId));
    assert.ok(!library.sources.some(s => s.id === original.sourceId));
    assert.ok(library.articles.some(a => a.id === article.id && a.sourceIds.includes(other.sourceId)));
    assert.equal((await importFetchedFeed(other.sourceId, otherData)).insertedCount, 0);
    assert.ok(await getStoredArticle(article.id));
  });

  it("rejects invalid or unknown targets without deleting anything", async () => {
    const before = (await listLibrary()).counts;
    await assert.rejects(deleteSource("not-an-id"), (e: unknown) => e instanceof LibraryError && e.code === "INVALID_ID");
    await assert.rejects(deleteSource(randomUUID()), (e: unknown) => e instanceof LibraryError && e.status === 404);
    assert.deepEqual((await listLibrary()).counts, before);
  });

  it("authorizes the DELETE route, rejects cross-site requests, and returns an idempotent result", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.LOCAL_DEV_AUTH_BYPASS = "1";
    delete process.env.VERCEL;
    const source = await confirmImport(await createPreview(feed()), "Route test", "world");
    const url = `http://127.0.0.1:3000/api/feeds/${source.sourceId}`;
    const context = { params: Promise.resolve({ id: source.sourceId }) };
    const denied = await DELETE(new Request(url, { method: "DELETE", headers: { origin: "https://foreign.example" } }), context);
    assert.equal(denied.status, 403);
    assert.ok(await getSource(source.sourceId));
    for (let i = 0; i < 2; i++) {
      const response = await DELETE(new Request(url, { method: "DELETE", headers: { origin: "http://127.0.0.1:3000" } }), context);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { sourceId: source.sourceId });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    assert.equal(await getSource(source.sourceId), null);
  });
});
