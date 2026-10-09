import type { PoolClient } from "pg";
import { articleUrlIdentity } from "../src/lib/article-identity";

type SavedArticle = {
  id: string; identity_key: string; url: string | null; summary: string | null;
  current_version_id: string | null;
  image_url: string | null; author: string | null; published_at: Date | null;
  updated_at: Date | null; first_seen_at: Date; last_fetched_at: Date;
};

type SavedVersion = {
  id: string; article_id: string; title: string; body: string;
  content_kind: string; language: string | null; content_hash: string;
  stored_at: Date;
};

async function mergeVersions(client: PoolClient, survivorId: string, articles: SavedArticle[]) {
  const articleIds = articles.map((article) => article.id);
  const currentIds = new Set(articles.map((article) => article.current_version_id).filter(Boolean));
  const { rows } = await client.query<SavedVersion>(`
    SELECT * FROM article_versions WHERE article_id = ANY($1::uuid[])
    ORDER BY (article_id = $2) DESC, stored_at, id`, [articleIds, survivorId]);
  const currentHashes = new Set(rows.filter((version) => currentIds.has(version.id)).map((version) => version.content_hash));
  const byHash = new Map<string, SavedVersion>();
  for (const version of rows) {
    const retained = byHash.get(version.content_hash);
    if (!retained) {
      byHash.set(version.content_hash, version);
      if (version.article_id !== survivorId) {
        await client.query("UPDATE article_versions SET article_id = $1 WHERE id = $2", [survivorId, version.id]);
      }
      continue;
    }
    if (retained.title !== version.title || retained.body !== version.body
      || retained.content_kind !== version.content_kind || retained.language !== version.language) {
      throw new Error(`文章版本哈希冲突，已取消合并：${version.id}`);
    }
    // Preserve the earliest observation of identical content and keep pointers
    // valid before the redundant version goes away.
    if (version.stored_at < retained.stored_at) {
      retained.stored_at = version.stored_at;
      await client.query("UPDATE article_versions SET stored_at = $1 WHERE id = $2", [retained.stored_at, retained.id]);
    }
    await client.query("UPDATE articles SET current_version_id = $1 WHERE current_version_id = $2", [retained.id, version.id]);
    await client.query("UPDATE article_sources SET current_version_id = $1 WHERE current_version_id = $2", [retained.id, version.id]);
    await client.query("DELETE FROM article_versions WHERE id = $1", [version.id]);
  }
  // Historical snapshots survive the merge, but must not replace a publisher's
  // newer edit simply because the old body was longer.
  return [...byHash.values()].filter((version) => currentHashes.has(version.content_hash)).sort((a, b) =>
    Number(b.content_kind === "rss_content") - Number(a.content_kind === "rss_content")
    || b.body.trim().length - a.body.trim().length
    || b.stored_at.getTime() - a.stored_at.getTime()
    || a.id.localeCompare(b.id))[0];
}

async function mergeArticles(client: PoolClient, articles: SavedArticle[], identity: string) {
  const [survivor] = articles;
  const articleIds = articles.map((article) => article.id);
  const duplicateIds = articleIds.slice(1);
  const bestVersion = await mergeVersions(client, survivor.id, articles);
  await client.query(`
    INSERT INTO article_sources (article_id, source_id, external_id, title, summary, current_version_id)
    SELECT $1, links.source_id, (
      SELECT external_id FROM article_sources identifiers
      WHERE identifiers.article_id = ANY($2::uuid[]) AND identifiers.source_id = links.source_id
        AND identifiers.external_id IS NOT NULL
      ORDER BY (identifiers.article_id = $1) DESC, identifiers.article_id LIMIT 1
    ), title, summary, current_version_id FROM (
      SELECT DISTINCT ON (source_id) source_id, title, summary, current_version_id
      FROM article_sources WHERE article_id = ANY($2::uuid[])
      ORDER BY source_id, (current_version_id IS NOT NULL) DESC,
        (title IS NOT NULL) DESC, (article_id = $1) DESC, article_id
    ) links
    ON CONFLICT (article_id, source_id) DO UPDATE SET
      external_id = COALESCE(article_sources.external_id, excluded.external_id),
      title = excluded.title, summary = excluded.summary,
      current_version_id = excluded.current_version_id`, [survivor.id, articleIds]);
  await client.query(`
    INSERT INTO article_bookmarks (article_id, bookmarked_at)
    SELECT $1, MIN(bookmarked_at) FROM article_bookmarks WHERE article_id = ANY($2::uuid[])
    HAVING COUNT(*) > 0
    ON CONFLICT (article_id) DO UPDATE SET bookmarked_at = LEAST(article_bookmarks.bookmarked_at, excluded.bookmarked_at);
  `, [survivor.id, articleIds]);
  await client.query(`
    INSERT INTO article_reads (article_id, read_at)
    SELECT $1, MIN(read_at) FROM article_reads WHERE article_id = ANY($2::uuid[])
    HAVING COUNT(*) > 0
    ON CONFLICT (article_id) DO UPDATE SET read_at = LEAST(article_reads.read_at, excluded.read_at);
  `, [survivor.id, articleIds]);
  await client.query("UPDATE article_aliases SET article_id = $1 WHERE article_id = ANY($2::uuid[])", [survivor.id, duplicateIds]);
  await client.query(`INSERT INTO article_aliases (alias_id, article_id)
    SELECT id, $1 FROM articles WHERE id = ANY($2::uuid[])
    ON CONFLICT (alias_id) DO UPDATE SET article_id = excluded.article_id`, [survivor.id, duplicateIds]);
  const preferred = articles.find((article) => article.id === bestVersion?.article_id) ?? survivor;
  const metadata = [preferred, ...articles.filter((article) => article !== preferred)];
  const newest = (values: (Date | null)[]) => values.filter((value): value is Date => !!value)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  // Deleting only happens after relationships and unique content have moved.
  // The surrounding transaction rolls everything back on any conflict.
  await client.query("DELETE FROM articles WHERE id = ANY($1::uuid[])", [duplicateIds]);
  await client.query(`UPDATE articles SET identity_key = $2,
    current_version_id = COALESCE($3, current_version_id), title = COALESCE($4, title),
    text_content = COALESCE($5, text_content), summary = $6, image_url = $7, author = $8,
    published_at = $9, updated_at = $10, last_fetched_at = $11 WHERE id = $1`, [
    survivor.id, identity, bestVersion?.id ?? null, bestVersion?.title ?? null, bestVersion?.body ?? null,
    metadata.find((article) => article.summary)?.summary ?? null,
    survivor.image_url ?? metadata.find((article) => article.image_url)?.image_url ?? null,
    survivor.author ?? metadata.find((article) => article.author)?.author ?? null,
    survivor.published_at ?? metadata.find((article) => article.published_at)?.published_at ?? null,
    newest(articles.map((article) => article.updated_at)), newest(articles.map((article) => article.last_fetched_at)),
  ]);
}

// Called inside migrate's transaction after legacy content versions exist.
export async function migrateArticleIdentities(client: PoolClient): Promise<void> {
  await client.query(`LOCK TABLE sources, articles, article_versions,
    article_sources, article_aliases, article_bookmarks, article_reads IN SHARE ROW EXCLUSIVE MODE`);
  await client.query(`INSERT INTO article_sources (article_id, source_id, external_id)
    SELECT id, source_id, external_id FROM articles
    ON CONFLICT (article_id, source_id) DO UPDATE SET
      external_id = COALESCE(article_sources.external_id, excluded.external_id)`);
  const { rows } = await client.query<SavedArticle>("SELECT * FROM articles ORDER BY first_seen_at, id");
  const groups = new Map<string, SavedArticle[]>();
  for (const article of rows) {
    const identity = article.url ? articleUrlIdentity(article.url) : null;
    if (!identity) continue;
    const group = groups.get(identity) ?? [];
    group.push(article);
    groups.set(identity, group);
    if (identity !== article.identity_key) {
      // Release stale keys before assigning normalized keys. This also handles
      // URL normalization changes when the global index already exists.
      await client.query("UPDATE articles SET identity_key = $1 WHERE id = $2", [`migration:${article.id}`, article.id]);
    }
  }
  for (const [identity, articles] of groups) {
    if (articles.length > 1) {
      await mergeArticles(client, articles, identity);
    } else if (articles[0].identity_key !== identity) {
      await client.query("UPDATE articles SET identity_key = $1 WHERE id = $2", [identity, articles[0].id]);
    }
  }
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS articles_url_identity_key
    ON articles (identity_key) WHERE identity_key LIKE 'url:%'`);
}
