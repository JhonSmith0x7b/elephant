import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getDb, getPool } from "../src/lib/db";
import { listLibrary } from "../src/lib/library";
import { articleBookmarks, articleSources, articles, sources } from "../src/lib/schema";
import { GET } from "../src/app/api/library/route";
import type { LibraryData } from "../src/lib/contracts";

const originalEnv = { ...process.env };
const schemaName = `rss_scope_test_${randomUUID().replaceAll("-", "")}`;
const worldSource = randomUUID();
const literatureSource = randomUUID();
const secondLiteratureSource = randomUUID();
const archivedSource = randomUUID();
const animeSource = randomUUID();
const worldIds = Array.from({ length: 125 }, () => randomUUID());
const literatureIds = Array.from({ length: 20 }, () => randomUUID());
const archivedId = randomUUID();
const animeId = randomUUID();
const expectedLiterature = new Set([...literatureIds, worldIds[0], archivedId]);

describe("library filtering before the feed limit in an isolated PostgreSQL schema", { skip: !originalEnv.DATABASE_URL }, () => {
  let admin: Pool;
  before(async () => {
    admin = new Pool({ connectionString: originalEnv.DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const url = new URL(originalEnv.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = url.toString();
    await migrate(getPool());
    const db = getDb();
    await db.insert(sources).values([
      { id: worldSource, name: "World", channel: "world" },
      { id: literatureSource, name: "Literature", channel: "literature" },
      { id: secondLiteratureSource, name: "Other literature", channel: "literature" },
      { id: archivedSource, name: "Archived literature", channel: "literature", deletedAt: new Date() },
      { id: animeSource, name: "Anime", channel: "anime" },
    ].map((source) => ({ ...source, feedUrl: `https://example.com/${source.id}/feed` })));
    const rows = [
      ...worldIds.map((id, index) => ({ id, sourceId: worldSource, publishedAt: new Date(Date.UTC(2026, 9, 8, 0, 0, index)) })),
      ...literatureIds.map((id, index) => ({ id, sourceId: literatureSource, publishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) })),
      { id: archivedId, sourceId: archivedSource, publishedAt: new Date("2025-12-01T00:00:00Z") },
      { id: animeId, sourceId: animeSource, publishedAt: new Date("2025-11-01T00:00:00Z") },
    ];
    await db.insert(articles).values(rows.map((row) => ({
      ...row, identityKey: `guid:${row.id}`, title: `Article ${row.id}`,
    })));
    // Exercise tied dates and fallback dates with precision beyond JS Dates.
    await getPool().query(`UPDATE articles SET published_at = '2026-10-08T00:00:00.000123Z' WHERE source_id = $1`, [worldSource]);
    await getPool().query(`UPDATE articles SET published_at = NULL, first_seen_at = '2026-10-08T00:00:00.000124Z' WHERE id = ANY($1::uuid[])`, [worldIds.slice(0, 40)]);
    await db.insert(articleSources).values([
      ...rows.map((row) => ({ articleId: row.id, sourceId: row.sourceId })),
      { articleId: worldIds[0], sourceId: literatureSource },
      { articleId: worldIds[0], sourceId: secondLiteratureSource },
      { articleId: archivedId, sourceId: animeSource },
      { articleId: animeId, sourceId: archivedSource },
    ]);
    await db.insert(articleBookmarks).values({ articleId: literatureIds[0] });
  });
  after(async () => {
    await getPool().end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env = originalEnv;
  });

  it("returns older literature even when more than 100 newer articles occupy the global feed", async () => {
    const global = await listLibrary();
    assert.equal(global.articles.length, 30);
    assert.ok(global.articles.every((article) => article.channel === "world"));
    assert.equal(global.articleCount, 147);

    const literature = await listLibrary({ channel: "literature" });
    assert.deepEqual(new Set(literature.articles.map((article) => article.id)), expectedLiterature);
    assert.equal(literature.articleCount, 22);
    assert.deepEqual(literature.counts, { sources: 4, articles: 147, bookmarks: 1 });
    assert.deepEqual(literature.sources, global.sources);
    assert.deepEqual(literature.channels, global.channels);
    assert.equal(literature.articles.find((article) => article.id === literatureIds[0])?.bookmarkedAt != null, true);

    const world = await listLibrary({ channel: "world" });
    assert.equal(world.articleCount, 125);
    assert.equal(world.articles.length, 30);
  });

  it("applies source filtering before limiting and counts shared articles once", async () => {
    const source = await listLibrary({ source: literatureSource });
    assert.deepEqual(new Set(source.articles.map((article) => article.id)), new Set([...literatureIds, worldIds[0]]));
    assert.equal(source.articleCount, 21);
    const shared = await listLibrary({ channel: "literature", source: secondLiteratureSource });
    assert.equal(shared.articles.length, 1);
    assert.equal(shared.articleCount, 1);
    assert.equal(shared.articles[0].id, worldIds[0]);
    assert.deepEqual(new Set(shared.articles[0].sourceIds), new Set([worldSource, literatureSource, secondLiteratureSource]));
  });

  it("retains a deleted primary source's category but ignores deleted secondary subscriptions", async () => {
    const literature = await listLibrary({ channel: "literature" });
    assert.ok(literature.articles.some((article) => article.id === archivedId));
    assert.ok(!literature.articles.some((article) => article.id === animeId));
    assert.ok(!literature.sources.some((source) => source.id === archivedSource));
    const anime = await listLibrary({ channel: "anime" });
    assert.deepEqual(new Set(anime.articles.map((article) => article.id)), new Set([archivedId, animeId]));
    assert.equal(anime.articleCount, 2);
  });

  it("normalizes unknown, deleted and incompatible scope values like the reader UI", async () => {
    for (const source of ["all", "not-a-uuid", randomUUID(), archivedSource, worldSource]) {
      const result = await listLibrary({ channel: "literature", source });
      assert.deepEqual(new Set(result.articles.map((article) => article.id)), expectedLiterature);
      assert.equal(result.articleCount, 22);
    }
    for (const channel of ["all", "unknown-channel"]) {
      const result = await listLibrary({ channel });
      assert.equal(result.articleCount, 147);
      assert.equal(result.articles.length, 30);
      const source = await listLibrary({ channel, source: literatureSource });
      assert.equal(source.articleCount, 21);
      assert.equal(source.articles.length, 21);
    }
  });

  it("paginates tied and microsecond dates without duplicates or gaps, preserving scoped totals", async () => {
    const expected = await getPool().query<{ id: string }>(`SELECT id FROM articles WHERE source_id = $1 ORDER BY coalesce(published_at, first_seen_at) DESC, id DESC`, [worldSource]);
    const collected: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await listLibrary({ channel: "world", source: worldSource, cursor });
      assert.equal(page.articleCount, 125);
      assert.equal(page.counts.articles, 147);
      assert.ok(page.articles.length <= 30);
      collected.push(...page.articles.map((article) => article.id));
      cursor = page.nextCursor;
      assert.ok(collected.length <= 125);
    } while (cursor);
    assert.deepEqual(collected, expected.rows.map((row) => row.id));
    assert.equal(new Set(collected).size, 125);
    assert.equal((await listLibrary({ channel: "literature" })).nextCursor, null);
  });

  it("rejects malformed cursors before querying", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of ["", "bad!", "a".repeat(257), encode({}), encode(["2026-02-30T00:00:00.000000Z", worldIds[0]]), encode(["2026-10-08T00:00:00.000123Z", "not-a-uuid"])]) {
      await assert.rejects(() => listLibrary({ cursor }), { code: "INVALID_CURSOR", status: 400 });
    }
  });

  it("forwards both filters from the API URL and keeps the response private", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.LOCAL_DEV_AUTH_BYPASS = "1";
    delete process.env.VERCEL;
    const response = await GET(new Request(`http://127.0.0.1:3000/api/library?channel=literature&source=${secondLiteratureSource}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const result = await response.json() as LibraryData;
    assert.equal(result.articleCount, 1);
    assert.deepEqual(result.articles.map((article) => article.id), [worldIds[0]]);
    assert.equal(result.counts.articles, 147);
    const first = await listLibrary({ channel: "world", source: worldSource });
    const second = await GET(new Request(`http://127.0.0.1:3000/api/library?channel=world&source=${worldSource}&cursor=${first.nextCursor}`));
    const next = await second.json() as LibraryData;
    assert.equal(next.articles.length, 30);
    assert.ok(next.articles.every((article) => !first.articles.some((previous) => previous.id === article.id)));
    assert.equal(next.articleCount, 125);
    const invalid = await GET(new Request("http://127.0.0.1:3000/api/library?cursor=bad!"));
    assert.equal(invalid.status, 400);
  });
});
