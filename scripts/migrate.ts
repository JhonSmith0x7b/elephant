import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getPool } from "../src/lib/db";
import { contentVersionHash, type VersionContent } from "../src/lib/article-content";
import { migrateArticleIdentities } from "./migrate-article-identities";
import { migrateSyncSettings } from "./migrate-sync-settings";

// Each statement is repeatable. A transaction keeps partial setup from being
// mistaken for a ready database; duplicate articles retain their data and aliases.
export async function migrate(pool: Pool = getPool()): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Use the import lock before taking table locks, so an in-flight import can
    // finish before schema changes and identity reconciliation start.
    await client.query("SELECT pg_advisory_xact_lock(742619381)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id text PRIMARY KEY,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
        normalized_name text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO channels (id, name, normalized_name)
      SELECT defaults.id, defaults.name, defaults.name
      FROM (VALUES ('literature', '文学'), ('anime', '二次元'), ('world', '时事')) AS defaults(id, name)
      WHERE NOT EXISTS (SELECT 1 FROM channels WHERE channels.id = defaults.id)
      ON CONFLICT (id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS sources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        feed_url text NOT NULL UNIQUE,
        site_url text,
        channel text NOT NULL,
        last_fetched_at timestamptz,
        last_error text
      );
      ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_channel_check;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'sources'::regclass AND conname = 'sources_channel_fkey'
        ) THEN
          ALTER TABLE sources ADD CONSTRAINT sources_channel_fkey
          FOREIGN KEY (channel) REFERENCES channels(id);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS sources_channel_idx ON sources (channel);
      CREATE TABLE IF NOT EXISTS articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        identity_key text NOT NULL,
        external_id text,
        title text NOT NULL,
        url text,
        summary text,
        text_content text,
        image_url text,
        author text,
        published_at timestamptz,
        updated_at timestamptz,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_fetched_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS articles_source_identity_key ON articles (source_id, identity_key);
      CREATE INDEX IF NOT EXISTS articles_source_id_idx ON articles (source_id);
      CREATE INDEX IF NOT EXISTS articles_published_at_idx ON articles (published_at);
      CREATE TABLE IF NOT EXISTS article_sources (
        article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        external_id text,
        PRIMARY KEY (article_id, source_id)
      );
      CREATE INDEX IF NOT EXISTS article_sources_source_id_idx ON article_sources (source_id);
      DROP INDEX IF EXISTS article_sources_source_external_id_idx;
      CREATE TABLE IF NOT EXISTS article_aliases (
        alias_id uuid PRIMARY KEY,
        article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS article_aliases_article_id_idx ON article_aliases (article_id);
      CREATE TABLE IF NOT EXISTS article_bookmarks (
        article_id uuid PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        bookmarked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS article_bookmarks_time_id_idx
        ON article_bookmarks (bookmarked_at DESC, article_id DESC);
      CREATE TABLE IF NOT EXISTS article_reads (
        article_id uuid PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        read_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE articles ADD COLUMN IF NOT EXISTS current_version_id uuid;
      CREATE INDEX IF NOT EXISTS articles_current_version_id_idx ON articles (current_version_id);
      CREATE TABLE IF NOT EXISTS article_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        title text NOT NULL,
        body text NOT NULL,
        content_kind text NOT NULL CHECK (content_kind IN ('rss_content', 'rss_description')),
        language text,
        content_hash text NOT NULL,
        stored_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS article_versions_article_hash_key ON article_versions (article_id, content_hash);
      -- Retain retired translations independently of live article lifecycles.
      -- New databases never create this archive or an active translation table.
      DO $$
      DECLARE foreign_key record;
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'article_translations') THEN
          IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'retired_article_translations') THEN
            RAISE EXCEPTION 'Both active and retired translation tables exist; resolve the archive conflict before migration';
          END IF;
          ALTER TABLE article_translations RENAME TO retired_article_translations;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'retired_article_translations') THEN
          FOR foreign_key IN
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'retired_article_translations'::regclass AND contype = 'f'
              AND confrelid = 'article_versions'::regclass
          LOOP
            EXECUTE format('ALTER TABLE retired_article_translations DROP CONSTRAINT %I', foreign_key.conname);
          END LOOP;
        END IF;
      END $$;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'articles'::regclass AND conname = 'articles_current_version_id_fkey'
        ) THEN
          ALTER TABLE articles ADD CONSTRAINT articles_current_version_id_fkey
          FOREIGN KEY (current_version_id) REFERENCES article_versions(id) ON DELETE SET NULL;
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS preview_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        data jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
        result jsonb
      );
      CREATE INDEX IF NOT EXISTS preview_records_expires_at_idx ON preview_records (expires_at);
    `);
    const legacy = await client.query<{
      id: string; title: string; text_content: string | null; summary: string | null; last_fetched_at: Date;
    }>(`SELECT id, title, text_content, summary, last_fetched_at FROM articles
        WHERE current_version_id IS NULL FOR UPDATE`);
    for (const article of legacy.rows) {
      const body = article.text_content?.trim() ? article.text_content : article.summary;
      if (!body?.trim()) continue;
      const content: VersionContent = {
        title: article.title, body,
        contentKind: article.text_content?.trim() ? "rss_content" : "rss_description",
        language: null,
      };
      const hash = contentVersionHash(content);
      await client.query(`INSERT INTO article_versions
        (article_id, title, body, content_kind, language, content_hash, stored_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (article_id, content_hash) DO NOTHING`,
      [article.id, content.title, body, content.contentKind, content.language, hash, article.last_fetched_at]);
      await client.query(`UPDATE articles SET current_version_id = (
        SELECT id FROM article_versions WHERE article_id = $1 AND content_hash = $2
      ) WHERE id = $1`, [article.id, hash]);
    }
    await client.query(`
      ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS title text;
      ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS summary text;
      ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS current_version_id uuid
        REFERENCES article_versions(id) ON DELETE SET NULL;
      INSERT INTO article_sources (article_id, source_id, external_id, title, summary, current_version_id)
      SELECT id, source_id, external_id, title, summary, current_version_id FROM articles
      ON CONFLICT (article_id, source_id) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, current_version_id = excluded.current_version_id
      WHERE article_sources.title IS NULL;
    `);
    await migrateArticleIdentities(client);
    await migrateSyncSettings(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then(() => console.log("数据库初始化完成。")).catch(() => {
    console.error("数据库初始化失败，请检查连接配置和数据库权限。");
    process.exitCode = 1;
  }).finally(() => getPool().end());
}
