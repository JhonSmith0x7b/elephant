import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getPool } from "../src/lib/db";
import {
  confirmImport,
  createPreview,
  getStoredArticle,
  importFetchedFeed,
  listLibrary,
  setArticleBookmark,
  setArticleRead,
} from "../src/lib/library";
import type { ParsedFeed, ParsedFeedItem } from "../src/lib/rss/types";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `rss_cross_source_test_${randomUUID().replaceAll("-", "")}`;

function item(id: string, extra: Partial<ParsedFeedItem> = {}): ParsedFeedItem {
  return {
    externalId: id, idKind: "guid", url: `https://example.com/articles/${id}`,
    title: `Article ${id}`, author: "Test author", publishedAt: "2026-01-01T08:00:00.000Z",
    updatedAt: null, summary: "A summary.", content: "Full article text.",
    contentKind: "rss_content", imageUrl: null,
    ...extra,
  };
}

function feed(items: ParsedFeedItem[]): ParsedFeed {
  return {
    url: `https://example.com/${randomUUID()}/feed`, title: "Test feed", description: null,
    siteUrl: "https://example.com/", language: "en", items,
  };
}

async function importFeed(data: ParsedFeed, name = "Test source") {
  return confirmImport(await createPreview(data), name, "literature");
}

async function articleFromSource(sourceId: string) {
  const library = await listLibrary();
  const matching = library.articles.filter((article) => article.sourceIds.includes(sourceId));
  assert.equal(matching.length, 1);
  return matching[0];
}

describe("article identity across RSS sources in an isolated PostgreSQL schema", { skip: !originalDatabaseUrl }, () => {
  let admin: Pool;

  before(async () => {
    admin = new Pool({ connectionString: originalDatabaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const testUrl = new URL(originalDatabaseUrl!);
    testUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = testUrl.toString();
    await migrate(getPool());
  });

  after(async () => {
    await getPool().end();
    // Only this test's randomly named schema is removed; public is never written.
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("stores shared 36kr permalinks once while retaining every source and source count", async () => {
    const before = (await listLibrary()).counts.articles;
    const firstFeed = feed([
      item("official-guid", { url: "https://www.36kr.com/newsflashes/3500000000001?f=rss&utm_source=reader#top" }),
      item("official-article", { url: "https://36kr.com/p/3500000000002?f=rss" }),
    ]);
    const secondFeed = feed([
      item("rsshub-guid", { url: "https://36kr.com/newsflashes/3500000000001" }),
      item("rsshub-article", { url: "https://www.36kr.com/p/3500000000002" }),
    ]);
    const first = await importFeed(firstFeed, "36kr official");
    const second = await importFeed(secondFeed, "36kr alternate");
    assert.equal(first.insertedCount, 2);
    assert.equal(second.insertedCount, 0);
    assert.equal(first.totalCount, 2);
    assert.equal(second.totalCount, 2);
    const library = await listLibrary();
    assert.equal(library.counts.articles, before + 2);
    for (const sourceId of [first.sourceId, second.sourceId]) {
      assert.equal(library.sources.find((source) => source.id === sourceId)?.articleCount, 2);
      const matches = library.articles.filter((article) => article.sourceIds.includes(sourceId));
      assert.equal(matches.length, 2);
      for (const article of matches) {
        assert.deepEqual(new Set(article.sourceIds), new Set([first.sourceId, second.sourceId]));
      }
    }
    assert.equal((await importFetchedFeed(second.sourceId, secondFeed)).insertedCount, 0);
    const links = await getPool().query(
      "SELECT count(*)::int AS count FROM article_sources WHERE source_id = ANY($1::uuid[])",
      [[first.sourceId, second.sourceId]],
    );
    assert.equal(links.rows[0].count, 4);
  });

  it("serializes simultaneous imports of the same permalink from different sources", async () => {
    const before = (await listLibrary()).counts.articles;
    const url = `https://example.com/concurrent/${randomUUID()}`;
    const [first, second] = await Promise.all([
      importFeed(feed([item("concurrent-first", { url })])),
      importFeed(feed([item("concurrent-second", { url })])),
    ]);
    assert.equal(first.insertedCount + second.insertedCount, 1);
    assert.equal(first.totalCount, 1);
    assert.equal(second.totalCount, 1);
    assert.equal((await listLibrary()).counts.articles, before + 1);
    const article = await articleFromSource(first.sourceId);
    assert.deepEqual(new Set(article.sourceIds), new Set([first.sourceId, second.sourceId]));
    assert.equal((await articleFromSource(second.sourceId)).id, article.id);
  });

  it("keeps matching GUIDs without article URLs separate between sources", async () => {
    const first = await importFeed(feed([item("shared-feed-local-guid", { url: null })]));
    const secondFeed = feed([item("shared-feed-local-guid", { url: null })]);
    const second = await importFeed(secondFeed);
    assert.equal(first.insertedCount, 1);
    assert.equal(second.insertedCount, 1);
    const firstArticle = await articleFromSource(first.sourceId);
    const secondArticle = await articleFromSource(second.sourceId);
    assert.notEqual(firstArticle.id, secondArticle.id);
    assert.deepEqual(firstArticle.sourceIds, [first.sourceId]);
    assert.deepEqual(secondArticle.sourceIds, [second.sourceId]);
    assert.equal((await importFetchedFeed(second.sourceId, secondFeed)).insertedCount, 0);
  });

  it("does not merge titles, distinct business parameters, or distinct permalinks sharing a GUID", async () => {
    const urls = [
      "https://example.com/same-title?edition=1",
      "https://example.com/same-title?edition=2",
      "https://example.com/same-title?f=rss",
      "https://example.com/same-title",
      "https://www.example.com/same-title",
      "https://36kr.com/p/3500000000003?edition=1",
      "https://www.36kr.com/p/3500000000003?edition=2",
    ];
    const data = feed(urls.map((url) => item("same-guid", { title: "The same headline", url })));
    const imported = await importFeed(data);
    assert.equal(imported.insertedCount, urls.length);
    assert.equal(imported.totalCount, urls.length);
    const listed = (await listLibrary()).articles.filter((article) => article.sourceIds.includes(imported.sourceId));
    assert.equal(listed.length, urls.length);
    assert.equal(new Set(listed.map((article) => article.id)).size, urls.length);
    assert.equal((await importFetchedFeed(imported.sourceId, data)).insertedCount, 0);
  });

  it("retains full text, read status, and bookmark when a secondary source refreshes", async () => {
    const url = `https://example.com/preserved/${randomUUID()}`;
    const body = "Complete first paragraph.\n\nComplete second paragraph.";
    const first = await importFeed(feed([item("full-guid", { url, title: "Saved article", content: body })]));
    const article = await articleFromSource(first.sourceId);
    const original = (await getStoredArticle(article.id))!.version!;
    const read = await setArticleRead(article.id, true);
    const bookmark = await setArticleBookmark(article.id, true);
    const secondFeed = feed([item("summary-guid", {
      url: `${url}?utm_source=alternate`, title: "Alternate feed headline", content: null,
      summary: "Only a short excerpt.", contentKind: "rss_description",
    })]);
    const second = await importFeed(secondFeed);
    secondFeed.items[0].content = "A revised short excerpt.";
    await importFetchedFeed(second.sourceId, secondFeed);
    const stored = (await getStoredArticle(article.id))!;
    assert.deepEqual(stored.version, original);
    assert.equal(stored.readAt, read.readAt);
    assert.equal(stored.bookmarkedAt, bookmark.bookmarkedAt);
    assert.deepEqual(new Set(stored.sourceIds), new Set([first.sourceId, second.sourceId]));
    assert.equal((await articleFromSource(second.sourceId)).id, article.id);
  });

  it("merges legacy duplicates without losing sources, content, state, or old article links", async () => {
    const prefix = `https://example.com/legacy/${randomUUID()}`;
    const shared = { title: "Legacy shared article", content: "Saved first paragraph.\n\nSaved second paragraph." };
    const first = await importFeed(feed([item("legacy-first", { ...shared, url: `${prefix}/first` })]));
    const second = await importFeed(feed([item("legacy-second", { ...shared, url: `${prefix}/second` })]));
    const firstArticle = await articleFromSource(first.sourceId);
    const secondArticle = await articleFromSource(second.sourceId);
    const read = await setArticleRead(secondArticle.id, true);
    const bookmark = await setArticleBookmark(firstArticle.id, true);

    // Reproduce the former per-source uniqueness model only in this test schema.
    await getPool().query("DROP INDEX articles_url_identity_key");
    await getPool().query("UPDATE articles SET url = $1 WHERE id = ANY($2::uuid[])",
      [`${prefix}/shared`, [firstArticle.id, secondArticle.id]]);
    await getPool().query("UPDATE articles SET first_seen_at = '2025-01-01' WHERE id = $1", [firstArticle.id]);
    await migrate(getPool());

    const migrated = (await getStoredArticle(firstArticle.id))!;
    assert.ok(migrated);
    assert.equal((await getStoredArticle(secondArticle.id))?.id, migrated.id);
    assert.equal(migrated.firstSeenAt, "2025-01-01T00:00:00.000Z");
    assert.equal(migrated.version?.body, shared.content);
    assert.equal(migrated.readAt, read.readAt);
    assert.equal(migrated.bookmarkedAt, bookmark.bookmarkedAt);
    assert.deepEqual(new Set(migrated.sourceIds), new Set([first.sourceId, second.sourceId]));
    const library = await listLibrary();
    for (const sourceId of [first.sourceId, second.sourceId]) {
      assert.equal(library.sources.find((source) => source.id === sourceId)?.articleCount, 1);
      assert.equal((await articleFromSource(sourceId)).id, migrated.id);
    }
    const counts = await getPool().query(`SELECT
      (SELECT count(*)::int FROM articles WHERE id = ANY($1::uuid[])) AS articles,
      (SELECT count(*)::int FROM article_versions WHERE article_id = $2) AS versions,
      (SELECT count(*)::int FROM article_aliases WHERE article_id = $2) AS aliases`,
    [[firstArticle.id, secondArticle.id], migrated.id]);
    assert.deepEqual(counts.rows[0], { articles: 1, versions: 1, aliases: 1 });

    await migrate(getPool());
    assert.deepEqual(await getStoredArticle(firstArticle.id), migrated);
    assert.deepEqual(await getStoredArticle(secondArticle.id), migrated);
    assert.deepEqual(await listLibrary(), library);
    const aliasId = migrated.id === firstArticle.id ? secondArticle.id : firstArticle.id;
    await setArticleRead(aliasId, false);
    await setArticleBookmark(aliasId, false);
    assert.equal((await getStoredArticle(migrated.id))?.readAt, null);
    assert.equal((await getStoredArticle(migrated.id))?.bookmarkedAt, null);
  });
});
