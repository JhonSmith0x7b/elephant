import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getPool } from "../src/lib/db";
import {
  confirmImport,
  createChannel,
  createPreview,
  getPreview,
  getSource,
  getStoredArticle,
  importFetchedFeed,
  LibraryError,
  listBookmarks,
  listLibrary,
  recordSourceFailure,
  renameChannel,
  setArticleBookmark,
  setArticleRead,
  updateSourceChannel,
} from "../src/lib/library";
import type { ParsedFeed, ParsedFeedItem } from "../src/lib/rss/types";
import { parseFeed } from "../src/lib/rss/parse";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `rss_import_test_${randomUUID().replaceAll("-", "")}`;

function item(id: string, extra: Partial<ParsedFeedItem> = {}): ParsedFeedItem {
  return {
    externalId: id, idKind: "guid", url: `https://example.com/articles/${id}`,
    title: `Article ${id}`, author: "Test author", publishedAt: "2026-01-01T08:00:00.000Z",
    updatedAt: null, summary: "A summary.", content: "Article text.", imageUrl: null,
    ...extra,
  };
}

function feed(items: ParsedFeedItem[], key = randomUUID()): ParsedFeed {
  return {
    url: `https://example.com/${key}/feed`, title: "Test feed", description: "A test feed.",
    siteUrl: "https://example.com/", language: "en", items,
  };
}

describe("RSS imports against an isolated PostgreSQL schema", { skip: !originalDatabaseUrl }, () => {
  let admin: Pool;

  before(async () => {
    admin = new Pool({ connectionString: originalDatabaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const testUrl = new URL(originalDatabaseUrl!);
    testUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = testUrl.toString();
    await migrate(getPool());
    // Re-running initialization must preserve existing schema objects.
    await migrate(getPool());
  });

  after(async () => {
    await getPool().end();
    // Only the randomly named schema created by this test is ever removed.
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("previews five items, imports once, and repeats confirmation idempotently", async () => {
    const data = feed(Array.from({ length: 7 }, (_, i) => item(`preview-${i}`)));
    const previewId = await createPreview(data);
    const preview = await getPreview(previewId);
    assert.equal(preview?.feed.itemCount, 7);
    assert.equal(preview?.feed.items.length, 5);

    const first = await confirmImport(previewId, "Original name", "literature");
    assert.deepEqual({ ...first, sourceId: "id" }, {
      sourceId: "id", insertedCount: 7, updatedCount: 0, totalCount: 7,
    });
    assert.deepEqual(await confirmImport(previewId, "Ignored on retry", "anime"), first);
    const source = await getSource(first.sourceId);
    assert.equal(source?.name, "Original name");
    assert.equal(source?.channel, "literature");
  });

  it("deduplicates repeated imports, tracking URLs, and duplicate entries in one feed", async () => {
    const data = feed([
      item("tracked", { url: "https://example.com/story?b=2&a=1&utm_source=rss#top" }),
      item("same-url-different-guid", { url: "https://example.com/story?a=1&b=2" }),
      item("another"),
    ]);
    const first = await confirmImport(await createPreview(data), "Duplicates", "literature");
    assert.equal(first.insertedCount, 2);
    assert.equal(first.totalCount, 2);
    const again = await confirmImport(await createPreview(data), "Duplicates", "literature");
    assert.equal(again.sourceId, first.sourceId);
    assert.equal(again.insertedCount, 0);
    assert.equal(again.updatedCount, 2);
    assert.equal(again.totalCount, 2);
  });

  it("bounds indexed URL and GUID identities while preserving the original values", async () => {
    const longUrl = `https://example.com/story?key=${randomBytes(900).toString("hex")}`;
    const longGuid = randomBytes(4000).toString("hex");
    const data = feed([
      item("long-url", { url: longUrl }),
      item(longGuid, { url: null }),
    ]);
    const result = await confirmImport(await createPreview(data), "Long identities", "literature");
    assert.equal(result.insertedCount, 2);
    const rows = await getPool().query("SELECT identity_key, external_id, url FROM articles WHERE source_id = $1", [result.sourceId]);
    const urlArticle = rows.rows.find((row) => row.url === longUrl);
    const guidArticle = rows.rows.find((row) => row.external_id === longGuid);
    assert.match(urlArticle.identity_key, /^url:[0-9a-f]{64}$/);
    assert.match(guidArticle.identity_key, /^id:[0-9a-f]{64}$/);
    const repeated = await importFetchedFeed(result.sourceId, data);
    assert.equal(repeated.insertedCount, 0);
    assert.equal(repeated.totalCount, 2);
  });

  it("cleans previews expired over 24 hours ago while retaining recent retry results", async () => {
    const oldPending = await createPreview(feed([item("old-pending")]));
    const oldCompleted = await createPreview(feed([item("old-completed")]));
    await confirmImport(oldCompleted, "Old completed", "literature");
    const recentExpired = await createPreview(feed([item("recent-expired")]));
    const recentCompleted = await createPreview(feed([item("recent-completed")]));
    const originalResult = await confirmImport(recentCompleted, "Recent completed", "literature");
    const unexpired = await createPreview(feed([item("unexpired")]));
    await getPool().query("UPDATE preview_records SET expires_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])", [[oldPending, oldCompleted]]);
    await getPool().query("UPDATE preview_records SET expires_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[recentExpired, recentCompleted]]);
    const created = await createPreview(feed([item("triggers-cleanup")]));
    const rows = await getPool().query("SELECT id FROM preview_records WHERE id = ANY($1::uuid[])", [[oldPending, oldCompleted, recentExpired, recentCompleted, unexpired, created]]);
    assert.deepEqual(new Set(rows.rows.map((row) => row.id)), new Set([recentExpired, recentCompleted, unexpired, created]));
    assert.deepEqual(await confirmImport(recentCompleted, "Ignored retry", "world"), originalResult);
    assert.ok(await getPreview(unexpired));
  });

  it("serializes concurrent confirmation and independent imports of the same source", async () => {
    const data = feed([item("parallel")]);
    const preview = await createPreview(data);
    const [a, b] = await Promise.all([
      confirmImport(preview, "Parallel", "anime"),
      confirmImport(preview, "Parallel", "anime"),
    ]);
    assert.deepEqual(a, b);
    const [c, d] = await Promise.all([
      createPreview(data).then((id) => confirmImport(id, "Parallel", "anime")),
      createPreview(data).then((id) => confirmImport(id, "Parallel", "anime")),
    ]);
    assert.equal(c.insertedCount + d.insertedCount, 0);
    assert.equal(c.totalCount, 1);
    assert.equal(d.totalCount, 1);
  });

  it("rejects expired previews without creating a source", async () => {
    const data = feed([item("expired")]);
    const preview = await createPreview(data);
    await getPool().query("UPDATE preview_records SET expires_at = now() - interval '1 second' WHERE id = $1", [preview]);
    assert.equal(await getPreview(preview), null);
    await assert.rejects(confirmImport(preview, "Expired", "world"),
      (error: unknown) => error instanceof LibraryError && error.code === "PREVIEW_EXPIRED");
    const result = await getPool().query("SELECT id FROM sources WHERE feed_url = $1", [data.url]);
    assert.equal(result.rowCount, 0);
  });

  it("rolls back the source, articles, and preview completion if a database write fails", async () => {
    await getPool().query("ALTER TABLE articles ADD CONSTRAINT test_reject_title CHECK (title <> '__FAIL_IMPORT__')");
    const data = feed([item("good-before-failure"), item("failure", { title: "__FAIL_IMPORT__" })]);
    const previewId = await createPreview(data);
    try {
      await assert.rejects(confirmImport(previewId, "Must roll back", "world"));
      const source = await getPool().query("SELECT id FROM sources WHERE feed_url = $1", [data.url]);
      const preview = await getPool().query("SELECT consumed_source_id, result FROM preview_records WHERE id = $1", [previewId]);
      assert.equal(source.rowCount, 0);
      assert.equal(preview.rows[0].consumed_source_id, null);
      assert.equal(preview.rows[0].result, null);
    } finally {
      await getPool().query("ALTER TABLE articles DROP CONSTRAINT test_reject_title");
    }
    const retry = await confirmImport(previewId, "Retry succeeds", "world");
    assert.equal(retry.insertedCount, 2);
    assert.equal(retry.totalCount, 2);
  });

  it("keeps firstSeenAt, retains known publication dates, and records fetch failures", async () => {
    const data = feed([
      item("dated"),
      item("undated", { publishedAt: null, url: null }),
    ]);
    const result = await confirmImport(await createPreview(data), "Refresh", "literature");
    // Pin a historical first-seen time so the assertion is independent of timing.
    await getPool().query("UPDATE articles SET first_seen_at = '2026-01-02T00:00:00Z' WHERE source_id = $1", [result.sourceId]);
    await recordSourceFailure(result.sourceId, "来源暂时不可用");
    assert.equal((await getSource(result.sourceId))?.lastError, "来源暂时不可用");

    data.items[0] = item("dated", { title: "Updated title", publishedAt: null });
    data.items[1] = item("undated", { publishedAt: null, url: "https://example.com/new-permalink" });
    data.items.push(item("fresh", { publishedAt: null }));
    const refreshed = await importFetchedFeed(result.sourceId, data);
    assert.equal(refreshed.insertedCount, 1);
    assert.equal(refreshed.updatedCount, 2);
    assert.equal(refreshed.totalCount, 3);
    assert.equal((await getSource(result.sourceId))?.lastError, null);

    const rows = await getPool().query("SELECT title, published_at, first_seen_at FROM articles WHERE source_id = $1", [result.sourceId]);
    const dated = rows.rows.find((row) => row.title === "Updated title");
    const undated = rows.rows.find((row) => row.title === "Article undated");
    assert.equal(dated.first_seen_at.toISOString(), "2026-01-02T00:00:00.000Z");
    assert.equal(dated.published_at.toISOString(), "2026-01-01T08:00:00.000Z");
    assert.equal(undated.published_at, null);
    assert.equal(undated.first_seen_at.toISOString(), "2026-01-02T00:00:00.000Z");
    const library = await listLibrary();
    assert.equal(library.sources.find((source) => source.id === result.sourceId)?.articleCount, 3);
    assert.equal(library.articles.find((article) => article.title === "Article undated")?.publishedAt, null);
    const actual = await getPool().query("SELECT count(*)::int AS total FROM articles");
    assert.equal(library.counts.articles, actual.rows[0].total);
  });

  it("skips damaged upstream titles without overwriting snapshots or losing read and bookmark state", async () => {
    const data = feed([item("encoding", { title: "日本监管机构要求金融公司审查网络安全" })]);
    const imported = await confirmImport(await createPreview(data), "36氪", "world");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    await setArticleBookmark(id, true);
    await setArticleRead(id, true);
    const original = await getStoredArticle(id);
    const damaged = parseFeed(`<rss version="2.0"><channel><title>News</title>
      <item><guid>encoding</guid><link>https://example.com/articles/encoding</link><title>日���监管机构</title><description>Changed body</description></item>
      <item><guid>bad-new</guid><title>日&#xfffd;监管机构</title></item>
      <item><guid>valid-new</guid><title>正常新闻</title></item>
      </channel></rss>`, data.url);
    const result = await importFetchedFeed(imported.sourceId, damaged);
    assert.equal(result.insertedCount, 1);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(await getStoredArticle(id), original);
    assert.match((await getSource(imported.sourceId))!.lastError!, /2 条标题含乱码/);
    const versionCount = await getPool().query("SELECT count(*)::int AS n FROM article_versions WHERE article_id = $1", [id]);
    assert.equal(versionCount.rows[0].n, 1);
    assert.ok((await listLibrary({ source: imported.sourceId })).articles.some((article) => article.id === id));

    data.items.push(item("bad-new", { url: null, title: "修复后的标题" }));
    const recovered = await importFetchedFeed(imported.sourceId, data);
    assert.equal(recovered.insertedCount, 1);
    assert.equal(recovered.totalCount, 3);
    assert.equal((await getSource(imported.sourceId))?.lastError, null);
    assert.deepEqual(await getStoredArticle(id), original);
    await setArticleBookmark(id, false);
    await setArticleRead(id, false);
  });

  it("stores complete immutable versions and reuses the exact current version on repeat or content reversion", async () => {
    const originalBody = "正文第一段。\n\n" + "完整内容。".repeat(6000);
    // No contentKind simulates a preview created before the version feature.
    const data = feed([item("versioned", { content: originalBody })]);
    const imported = await confirmImport(await createPreview(data), "Versions", "literature");
    const articleRow = await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId]);
    const articleId = articleRow.rows[0].id;
    const first = await getStoredArticle(articleId);
    assert.equal(first?.version?.body, originalBody);
    assert.equal(first?.version?.contentKind, "rss_content");
    assert.equal(first?.version?.language, "en");
    assert.equal(first?.url, data.items[0].url);

    await importFetchedFeed(imported.sourceId, data);
    assert.deepEqual((await getStoredArticle(articleId))?.version, first?.version);
    const secondData = { ...data, items: [{ ...data.items[0], content: "Revised body." }] };
    await importFetchedFeed(imported.sourceId, secondData);
    const second = await getStoredArticle(articleId);
    assert.notEqual(second?.version?.id, first?.version?.id);
    assert.equal(second?.version?.body, "Revised body.");
    const original = await getPool().query("SELECT body, content_hash FROM article_versions WHERE id = $1", [first!.version!.id]);
    assert.equal(original.rows[0].body, originalBody);
    assert.equal(original.rows[0].content_hash, first?.version?.contentHash);

    await importFetchedFeed(imported.sourceId, data);
    assert.deepEqual((await getStoredArticle(articleId))?.version, first?.version);
    const versions = await getPool().query("SELECT count(*)::int AS count FROM article_versions WHERE article_id = $1", [articleId]);
    assert.equal(versions.rows[0].count, 2);
    assert.equal("textContent" in (await listLibrary()).articles.find((article) => article.id === articleId)!, false);
  });

  it("versions title, language, and content kind changes independently", async () => {
    const data = feed([item("metadata", { content: "Same body", contentKind: "rss_description" })]);
    const imported = await confirmImport(await createPreview(data), "Version metadata", "literature");
    const rows = await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId]);
    const articleId = rows.rows[0].id;
    const initial = (await getStoredArticle(articleId))!.version!;
    data.items[0].contentKind = "rss_content";
    await importFetchedFeed(imported.sourceId, data);
    const full = (await getStoredArticle(articleId))!.version!;
    assert.notEqual(full.id, initial.id);
    data.items[0].title = "Corrected title";
    await importFetchedFeed(imported.sourceId, data);
    const titleChange = (await getStoredArticle(articleId))!.version!;
    assert.notEqual(titleChange.id, full.id);
    data.language = "ja";
    await importFetchedFeed(imported.sourceId, data);
    const languageChange = (await getStoredArticle(articleId))!.version!;
    assert.notEqual(languageChange.id, titleChange.id);
    assert.equal(languageChange.language, "ja");
    const versions = await getPool().query("SELECT count(*)::int AS count FROM article_versions WHERE article_id = $1", [articleId]);
    assert.equal(versions.rows[0].count, 4);
  });

  it("uses descriptions when needed and never downgrades saved full text during later refreshes", async () => {
    const data = feed([item("fallback", { content: null, summary: "Initial description." })]);
    const imported = await confirmImport(await createPreview(data), "Content fallback", "literature");
    const rows = await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId]);
    const articleId = rows.rows[0].id;
    const description = (await getStoredArticle(articleId))!.version!;
    assert.equal(description.body, "Initial description.");
    assert.equal(description.contentKind, "rss_description");
    data.items[0].content = "Saved full article.";
    data.items[0].contentKind = "rss_content";
    await importFetchedFeed(imported.sourceId, data);
    const full = (await getStoredArticle(articleId))!.version!;
    assert.equal(full.contentKind, "rss_content");
    data.items[0].content = "Short description returned in content.";
    data.items[0].contentKind = "rss_description";
    await importFetchedFeed(imported.sourceId, data);
    assert.deepEqual((await getStoredArticle(articleId))!.version, full);
    data.items[0].content = null;
    data.items[0].summary = null;
    await importFetchedFeed(imported.sourceId, data);
    assert.deepEqual((await getStoredArticle(articleId))!.version, full);
    const stored = await getPool().query("SELECT text_content FROM articles WHERE id = $1", [articleId]);
    assert.equal(stored.rows[0].text_content, "Saved full article.");
    const versions = await getPool().query("SELECT count(*)::int AS count FROM article_versions WHERE article_id = $1", [articleId]);
    assert.equal(versions.rows[0].count, 2);
  });

  it("rolls back article changes and current-version pointers when a version insert fails", async () => {
    const data = feed([item("before-version-failure")]);
    const imported = await confirmImport(await createPreview(data), "Version rollback", "literature");
    const before = await getPool().query("SELECT id, title, current_version_id, last_fetched_at FROM articles WHERE source_id = $1", [imported.sourceId]);
    const initial = before.rows[0];
    data.items[0].title = "Should be rolled back";
    data.items[0].content = "__FAIL_VERSION__";
    data.items.push(item("new-before-failure"));
    await getPool().query("ALTER TABLE article_versions ADD CONSTRAINT test_reject_body CHECK (body <> '__FAIL_VERSION__')");
    try {
      await assert.rejects(importFetchedFeed(imported.sourceId, data));
      const after = await getPool().query("SELECT id, title, current_version_id, last_fetched_at FROM articles WHERE source_id = $1", [imported.sourceId]);
      assert.deepEqual(after.rows, [initial]);
      const versions = await getPool().query("SELECT count(*)::int AS count FROM article_versions WHERE article_id = $1", [initial.id]);
      assert.equal(versions.rows[0].count, 1);
    } finally {
      await getPool().query("ALTER TABLE article_versions DROP CONSTRAINT test_reject_body");
    }
  });

  it("backfills existing full text and summary records without changing article ids or duplicating versions", async () => {
    const sourceId = randomUUID();
    await getPool().query("INSERT INTO sources (id, name, feed_url, channel) VALUES ($1, 'Legacy source', $2, 'literature')", [sourceId, `https://example.com/legacy-${sourceId}/feed`]);
    const fullId = randomUUID();
    const summaryId = randomUUID();
    const emptyId = randomUUID();
    await getPool().query(`INSERT INTO articles
      (id, source_id, identity_key, title, text_content, summary, first_seen_at, last_fetched_at)
      VALUES ($1, $4, 'legacy-full', 'Legacy title', 'Legacy full text.', 'Short summary.', '2026-01-01', '2026-01-02'),
             ($2, $4, 'legacy-summary', 'Summary title', NULL, 'Legacy description.', '2026-01-01', '2026-01-02'),
             ($3, $4, 'legacy-empty', 'Empty title', NULL, NULL, '2026-01-01', '2026-01-02')`,
    [fullId, summaryId, emptyId, sourceId]);
    await migrate(getPool());
    const full = (await getStoredArticle(fullId))!;
    const summary = (await getStoredArticle(summaryId))!;
    assert.equal(full.id, fullId);
    assert.equal(full.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(full.version?.body, "Legacy full text.");
    assert.equal(full.version?.contentKind, "rss_content");
    assert.equal(full.version?.language, null);
    assert.equal(summary.version?.body, "Legacy description.");
    assert.equal(summary.version?.contentKind, "rss_description");
    assert.equal((await getStoredArticle(emptyId))?.version, null);
    await migrate(getPool());
    assert.deepEqual((await getStoredArticle(fullId))?.version, full.version);
    assert.deepEqual((await getStoredArticle(summaryId))?.version, summary.version);
    const count = await getPool().query("SELECT count(*)::int AS count FROM article_versions WHERE article_id = ANY($1::uuid[])", [[fullId, summaryId, emptyId]]);
    assert.equal(count.rows[0].count, 2);
    assert.equal(await getStoredArticle(randomUUID()), null);
  });

  it("serves source content consistently and retains prior versions when the publisher revises an article", async () => {
    const data = feed([item("original-content", { content: "First paragraph.\n\nSecond paragraph." })]);
    const imported = await confirmImport(await createPreview(data), "Original content", "literature");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    const original = (await getStoredArticle(id))!.version!;
    const listed = (await listLibrary()).articles.find((article) => article.id === id)!;
    assert.equal(listed.title, data.items[0].title);
    assert.equal(listed.summary, data.items[0].summary);
    assert.equal(original.body, data.items[0].content);
    assert.ok(!("translation" in (await getStoredArticle(id))!));
    assert.ok(!("translationLanguage" in listed));

    data.items[0].content = "A revised source paragraph.";
    await importFetchedFeed(imported.sourceId, data);
    const revised = (await getStoredArticle(id))!;
    assert.notEqual(revised.version?.id, original.id);
    assert.equal(revised.version?.body, data.items[0].content);
    assert.equal(revised.title, data.items[0].title);
    const savedOriginal = await getPool().query("SELECT body FROM article_versions WHERE id = $1", [original.id]);
    assert.equal(savedOriginal.rows[0].body, original.body);
  });

  it("persists idempotent bookmarks and cancellation without changing stored content", async () => {
    const data = feed([item("bookmark-idempotent")]);
    const imported = await confirmImport(await createPreview(data), "Bookmark", "literature");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    const version = (await getStoredArticle(id))!.version!;
    const baseline = await getStoredArticle(id);
    const first = await setArticleBookmark(id, true);
    assert.ok(first.bookmarkedAt);
    const repeats = await Promise.all(Array.from({ length: 3 }, () => setArticleBookmark(id, true)));
    for (const repeat of repeats) assert.deepEqual(repeat, first);
    const stored = await getStoredArticle(id);
    assert.deepEqual(stored, { ...baseline, bookmarkedAt: first.bookmarkedAt });
    assert.deepEqual(stored!.version, version);
    const library = await listLibrary();
    assert.equal(library.counts.bookmarks, 1);
    assert.equal(library.articles.find((article) => article.id === id)!.bookmarkedAt, first.bookmarkedAt);
    const saved = await listBookmarks();
    assert.equal(saved.total, 1);
    assert.equal(saved.articles[0].id, id);
    assert.equal(saved.articles[0].title, data.items[0].title);
    assert.equal(saved.nextCursor, null);
    assert.deepEqual(await setArticleBookmark(id, false), { articleId: id, bookmarkedAt: null });
    assert.deepEqual(await setArticleBookmark(id, false), { articleId: id, bookmarkedAt: null });
    assert.deepEqual(await getStoredArticle(id), baseline);
    assert.deepEqual(await listBookmarks(), { articles: [], total: 0, nextCursor: null });
    assert.equal((await listLibrary()).counts.bookmarks, 0);
  });

  it("rejects missing articles and invalid bookmark ids or cursors", async () => {
    for (const bookmarked of [true, false]) {
      await assert.rejects(setArticleBookmark(randomUUID(), bookmarked),
        (error: unknown) => error instanceof LibraryError && error.code === "ARTICLE_NOT_FOUND" && error.status === 404);
      await assert.rejects(setArticleBookmark("not-an-article", bookmarked),
        (error: unknown) => error instanceof LibraryError && error.code === "INVALID_ID");
    }
    const invalidCursors = [
      "", "not-json", "x".repeat(257),
      ...[
        ["2026-02-31T00:00:00.000000Z", randomUUID()],
        ["0000-01-01T00:00:00.000000Z", randomUUID()],
        ["2026-01-01T00:00:00.000000Z", "wrong-id"],
      ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")),
    ];
    for (const cursor of invalidCursors) {
      await assert.rejects(listBookmarks(cursor),
        (error: unknown) => error instanceof LibraryError && error.code === "INVALID_CURSOR");
    }
    assert.equal((await listLibrary()).counts.bookmarks, 0);
  });

  it("retains the bookmark when RSS refresh updates the same article", async () => {
    const data = feed([item("bookmarked-refresh")]);
    const imported = await confirmImport(await createPreview(data), "Saved refresh", "literature");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    const original = (await getStoredArticle(id))!.version!;
    const first = await setArticleBookmark(id, true);
    data.items[0] = { ...data.items[0], title: "Updated bookmarked title", content: "Updated saved text." };
    await importFetchedFeed(imported.sourceId, data);
    const current = (await getStoredArticle(id))!;
    assert.equal(current.bookmarkedAt, first.bookmarkedAt);
    assert.equal(current.version!.body, "Updated saved text.");
    assert.notEqual(current.version!.id, original.id);
    const list = await listBookmarks();
    assert.equal(list.articles[0].id, id);
    assert.equal(list.articles[0].title, data.items[0].title);
    const old = await getPool().query("SELECT body FROM article_versions WHERE id = $1", [original.id]);
    assert.equal(old.rows[0].body, original.body);
    await setArticleBookmark(id, false);
  });

  it("finds bookmarked old articles beyond the latest 100 library entries", async () => {
    const data = feed([
      item("old-saved-article", { publishedAt: "2000-01-01T00:00:00.000Z" }),
      ...Array.from({ length: 100 }, (_, i) => item(`newer-${i}`, { publishedAt: "2026-10-01T00:00:00.000Z" })),
    ]);
    const imported = await confirmImport(await createPreview(data), "Bookmark archive", "literature");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1 AND external_id = 'old-saved-article'", [imported.sourceId])).rows;
    await setArticleBookmark(id, true);
    const library = await listLibrary();
    assert.equal(library.articles.length, 100);
    assert.equal(library.articles.some((article) => article.id === id), false);
    assert.equal(library.counts.bookmarks, 1);
    const saved = await listBookmarks();
    assert.equal(saved.total, 1);
    assert.equal(saved.articles[0].id, id);
    assert.ok((await getStoredArticle(id))!.bookmarkedAt);
    await setArticleBookmark(id, false);
  });

  it("paginates equal bookmark timestamps without duplicates or omissions and preserves microseconds", async () => {
    const data = feed(Array.from({ length: 65 }, (_, i) => item(`bookmark-page-${i}`)));
    const imported = await confirmImport(await createPreview(data), "Bookmark pages", "literature");
    await getPool().query(`INSERT INTO article_bookmarks (article_id, bookmarked_at)
      SELECT id, '2026-10-08T02:00:00.123456Z' FROM articles WHERE source_id = $1`, [imported.sourceId]);
    // Two adjacent microseconds share the same JS millisecond. The cursor
    // must retain all six digits to avoid excluding the remaining ties.
    await getPool().query(`UPDATE article_bookmarks SET bookmarked_at = '2026-10-08T02:00:00.123457Z'
      WHERE article_id IN (SELECT id FROM articles WHERE source_id = $1 ORDER BY id LIMIT 2)`, [imported.sourceId]);
    const expected = await getPool().query("SELECT article_id FROM article_bookmarks ORDER BY bookmarked_at DESC, article_id DESC");
    const first = await listBookmarks();
    assert.equal(first.articles.length, 30);
    assert.equal(first.total, 65);
    assert.ok(first.nextCursor);
    const second = await listBookmarks(first.nextCursor);
    assert.equal(second.articles.length, 30);
    assert.equal(second.total, 65);
    assert.ok(second.nextCursor);
    const third = await listBookmarks(second.nextCursor);
    assert.equal(third.articles.length, 5);
    assert.equal(third.nextCursor, null);
    const found = [...first.articles, ...second.articles, ...third.articles].map((article) => article.id);
    assert.deepEqual(found, expected.rows.map((row) => row.article_id));
    assert.equal(new Set(found).size, 65);
    // Deleting a source also cleans up its bookmark rows through the article FK.
    await getPool().query("DELETE FROM sources WHERE id = $1", [imported.sourceId]);
    assert.equal((await listBookmarks()).total, 0);
  });

  it("migrates the old fixed-channel check and preserves renamed defaults on repeated setup", async () => {
    await getPool().query("ALTER TABLE sources ADD CONSTRAINT sources_channel_check CHECK (channel IN ('literature', 'anime', 'world'))");
    await renameChannel("literature", "文学与书籍");
    // A user may reuse the original default name for another category.
    const reused = await createChannel("文学");
    await migrate(getPool());
    await migrate(getPool());
    const library = await listLibrary();
    assert.equal(library.channels.find((channel) => channel.id === "literature")!.name, "文学与书籍");
    assert.equal(library.channels.find((channel) => channel.id === reused.id)!.name, "文学");
    assert.deepEqual(library.channels.slice(0, 3).map((channel) => channel.id), ["literature", "anime", "world"]);
    const constraints = await getPool().query("SELECT conname FROM pg_constraint WHERE conrelid = 'sources'::regclass");
    assert.equal(constraints.rows.some((row) => row.conname === "sources_channel_check"), false);
    assert.equal(constraints.rows.some((row) => row.conname === "sources_channel_fkey"), true);
  });

  it("normalizes category names, rejects duplicates atomically, and validates rename targets", async () => {
    const channel = await createChannel("  Games   &   Art  ");
    assert.equal(channel.name, "Games & Art");
    await assert.rejects(createChannel("ＧＡＭＥＳ & ART"),
      (error: unknown) => error instanceof LibraryError && error.code === "CHANNEL_EXISTS" && error.status === 409);
    await assert.rejects(renameChannel("anime", "games & art"),
      (error: unknown) => error instanceof LibraryError && error.code === "CHANNEL_EXISTS" && error.status === 409);
    assert.deepEqual(await renameChannel(channel.id, "Games & Art"), channel);
    for (const name of ["  ", "字".repeat(25)]) {
      await assert.rejects(createChannel(name),
        (error: unknown) => error instanceof LibraryError && error.code === "INVALID_CHANNEL_NAME");
    }
    await assert.rejects(renameChannel(randomUUID(), "Missing category"),
      (error: unknown) => error instanceof LibraryError && error.code === "CHANNEL_NOT_FOUND" && error.status === 404);
    const results = await Promise.allSettled([createChannel("音乐"), createChannel(" 音乐 ")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.ok(failed?.status === "rejected" && failed.reason instanceof LibraryError && failed.reason.status === 409);
  });

  it("imports custom categories and moves sources with their articles while retaining saved content", async () => {
    const channel = await createChannel("影视");
    const destination = await createChannel("影像文化");
    const data = feed([item("custom-category", { publishedAt: "2026-12-01T00:00:00.000Z" })]);
    const imported = await confirmImport(await createPreview(data), "Custom category source", channel.id);
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    assert.equal((await getSource(imported.sourceId))!.channelName, "影视");
    const before = (await getStoredArticle(id))!;
    await setArticleBookmark(id, true);
    const moved = await updateSourceChannel(imported.sourceId, destination.id);
    assert.equal(moved.channel, destination.id);
    assert.equal(moved.channelName, "影像文化");
    await renameChannel(destination.id, "电影与文化");
    const library = await listLibrary();
    const source = library.sources.find((source) => source.id === imported.sourceId)!;
    assert.equal(source.channelName, "电影与文化");
    assert.equal(source.articleCount, 1);
    const listed = library.articles.find((article) => article.id === id)!;
    assert.equal(listed.channel, destination.id);
    assert.equal(listed.channelName, "电影与文化");
    const stored = (await getStoredArticle(id))!;
    assert.deepEqual(stored.version, before.version);
    assert.equal(stored.channelName, "电影与文化");
    assert.equal((await listBookmarks()).articles.find((article) => article.id === id)!.channelName, "电影与文化");
    await setArticleBookmark(id, false);
  });

  it("rejects unknown categories during import and moves without altering the source", async () => {
    const data = feed([item("invalid-category")]);
    const preview = await createPreview(data);
    await assert.rejects(confirmImport(preview, "Invalid category", randomUUID()),
      (error: unknown) => error instanceof LibraryError && error.code === "INVALID_CHANNEL");
    assert.equal((await getPool().query("SELECT id FROM sources WHERE feed_url = $1", [data.url])).rowCount, 0);
    const imported = await confirmImport(preview, "Valid category", "world");
    await assert.rejects(updateSourceChannel(imported.sourceId, randomUUID()),
      (error: unknown) => error instanceof LibraryError && error.code === "INVALID_CHANNEL");
    assert.equal((await getSource(imported.sourceId))!.channel, "world");
    await assert.rejects(updateSourceChannel(randomUUID(), "anime"),
      (error: unknown) => error instanceof LibraryError && error.code === "SOURCE_NOT_FOUND" && error.status === 404);
    await assert.rejects(updateSourceChannel("invalid-id", "anime"),
      (error: unknown) => error instanceof LibraryError && error.code === "INVALID_ID");
  });

  it("persists read state across repeated opens and RSS updates and supports marking unread", async () => {
    const data = feed([item("read-state", { publishedAt: "2026-12-02T00:00:00.000Z" })]);
    const imported = await confirmImport(await createPreview(data), "Read state", "literature");
    const [{ id }] = (await getPool().query("SELECT id FROM articles WHERE source_id = $1", [imported.sourceId])).rows;
    const baseline = (await getStoredArticle(id))!;
    assert.equal(baseline.readAt, null);
    const first = await setArticleRead(id, true);
    assert.ok(first.readAt);
    const repeats = await Promise.all(Array.from({ length: 3 }, () => setArticleRead(id, true)));
    for (const repeat of repeats) assert.deepEqual(repeat, first);
    assert.deepEqual(await getStoredArticle(id), { ...baseline, readAt: first.readAt });
    data.items[0].content = "Updated article body.";
    await importFetchedFeed(imported.sourceId, data);
    const updated = (await getStoredArticle(id))!;
    assert.equal(updated.readAt, first.readAt);
    assert.equal(updated.version!.body, "Updated article body.");
    assert.equal((await listLibrary()).articles.find((article) => article.id === id)!.readAt, first.readAt);
    await setArticleBookmark(id, true);
    assert.equal((await listBookmarks()).articles.find((article) => article.id === id)!.readAt, first.readAt);
    assert.deepEqual(await setArticleRead(id, false), { articleId: id, readAt: null });
    assert.deepEqual(await setArticleRead(id, false), { articleId: id, readAt: null });
    assert.deepEqual((await getStoredArticle(id))!.version, updated.version);
    assert.equal((await getStoredArticle(id))!.readAt, null);
    assert.ok((await getStoredArticle(id))!.bookmarkedAt);
    await setArticleBookmark(id, false);
  });

  it("rejects missing articles, invalid ids, and non-boolean read state", async () => {
    for (const read of [true, false]) {
      await assert.rejects(setArticleRead(randomUUID(), read),
        (error: unknown) => error instanceof LibraryError && error.code === "ARTICLE_NOT_FOUND" && error.status === 404);
      await assert.rejects(setArticleRead("invalid-id", read),
        (error: unknown) => error instanceof LibraryError && error.code === "INVALID_ID");
    }
    await assert.rejects(setArticleRead(randomUUID(), "true" as unknown as boolean),
      (error: unknown) => error instanceof LibraryError && error.code === "INVALID_READ");
  });
});
