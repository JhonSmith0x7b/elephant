import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate";
import { getPool } from "../src/lib/db";
import {
  confirmImport, createPreview, getStoredArticle, importFetchedFeed, listBookmarks,
  listLibrary, setArticleBookmark, setArticleRead,
} from "../src/lib/library";
import type { ParsedFeed } from "../src/lib/rss/types";

const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `rss_original_content_test_${randomUUID().replaceAll("-", "")}`;

function feed(): ParsedFeed {
  const key = randomUUID();
  return {
    url: `https://example.com/${key}/feed`, title: "Source content", description: null,
    siteUrl: "https://example.com/", language: "en",
    items: [{
      externalId: key, idKind: "guid", url: `https://example.com/articles/${key}`,
      title: "The source title", content: "Original first paragraph.\n\nOriginal second paragraph.",
      contentKind: "rss_content", summary: "The source summary.", author: null,
      imageUrl: null, publishedAt: null, updatedAt: null,
    }],
  };
}

async function originalSnapshot() {
  const pool = getPool();
  const tables = ["sources", "articles", "article_versions", "article_sources", "article_aliases", "article_reads", "article_bookmarks"];
  return Object.fromEntries(await Promise.all(tables.map(async table => [
    table,
    (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows,
  ])));
}

describe("retiring translated variants while retaining source content", { skip: !originalDatabaseUrl }, () => {
  let admin: Pool;
  before(async () => {
    admin = new Pool({ connectionString: originalDatabaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    const url = new URL(originalDatabaseUrl!);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    process.env.DATABASE_URL = url.toString();
    await migrate(getPool());
  });
  after(async () => {
    await getPool().end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.end();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("creates no translation tables on a fresh installation", async () => {
    const { rows } = await getPool().query(`SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename IN ('article_translations', 'retired_article_translations')`);
    assert.deepEqual(rows, []);
  });

  it("archives all legacy variants without changing source content, history, links, reads or bookmarks", async () => {
    const data = feed();
    const imported = await confirmImport(await createPreview(data), "Original source", "literature");
    const article = (await listLibrary()).articles[0];
    const firstVersion = (await getStoredArticle(article.id))!.version!;
    data.items[0].content = "Revised source first paragraph.\n\nRevised source second paragraph.";
    await importFetchedFeed(imported.sourceId, data);
    const currentVersion = (await getStoredArticle(article.id))!.version!;
    await setArticleRead(article.id, true);
    await setArticleBookmark(article.id, true);
    const alias = randomUUID();
    await getPool().query("INSERT INTO article_aliases (alias_id, article_id) VALUES ($1, $2)", [alias, article.id]);

    // Emulate the former table exactly, only inside this isolated test schema.
    await getPool().query(`CREATE TABLE article_translations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id uuid NOT NULL REFERENCES article_versions(id) ON DELETE CASCADE,
      language text NOT NULL CHECK (language = 'zh-CN'), title text NOT NULL,
      summary text NOT NULL, body text NOT NULL, translator text NOT NULL,
      translated_at timestamptz NOT NULL DEFAULT now()
    ); CREATE UNIQUE INDEX article_translations_version_language_key ON article_translations (version_id, language)`);
    for (const version of [firstVersion, currentVersion]) {
      await getPool().query(`INSERT INTO article_translations
        (version_id, language, title, summary, body, translator, translated_at)
        VALUES ($1, 'zh-CN', '旧中文标题', '旧中文导读', '旧中文正文', 'Codex', '2026-01-01T00:00:00Z')`, [version.id]);
    }
    const variants = (await getPool().query("SELECT * FROM article_translations ORDER BY id")).rows;
    const originals = await originalSnapshot();
    const detail = await getStoredArticle(article.id);
    const library = await listLibrary();
    const bookmarks = await listBookmarks();
    assert.equal(detail?.title, data.items[0].title);
    assert.equal(detail?.summary, data.items[0].summary);
    assert.equal(detail?.version?.body, data.items[0].content);
    assert.ok(!("translation" in detail!));
    assert.ok(!("translationLanguage" in library.articles[0]));
    assert.equal(bookmarks.articles[0].title, data.items[0].title);

    await migrate(getPool());
    await migrate(getPool());
    assert.deepEqual(await originalSnapshot(), originals);
    assert.deepEqual(await getStoredArticle(article.id), detail);
    assert.deepEqual(await getStoredArticle(alias), detail);
    assert.deepEqual(await listLibrary(), library);
    assert.deepEqual(await listBookmarks(), bookmarks);
    assert.equal((await getPool().query("SELECT to_regclass('article_translations') AS name")).rows[0].name, null);
    assert.deepEqual((await getPool().query("SELECT * FROM retired_article_translations ORDER BY id")).rows, variants);
    assert.equal((await getPool().query(`SELECT count(*)::int AS total FROM pg_constraint
      WHERE conrelid = 'retired_article_translations'::regclass AND contype = 'f'`)).rows[0].total, 0);

    // Retired rows survive even if a live article is later removed. Roll back
    // this probe so the test retains its original source and version snapshots.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM articles WHERE id = $1", [article.id]);
      assert.deepEqual((await client.query("SELECT * FROM retired_article_translations ORDER BY id")).rows, variants);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.deepEqual(await originalSnapshot(), originals);
  });
});
