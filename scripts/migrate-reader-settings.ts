import type { PoolClient } from "pg";

export async function migrateReaderSettings(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS reader_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      article_sort text NOT NULL DEFAULT 'published'
        CHECK (article_sort IN ('published', 'collected'))
    );
    INSERT INTO reader_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS articles_first_seen_at_id_idx
      ON articles (first_seen_at DESC, id DESC);
  `);
}
