import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, type Database } from "./db";
import {
  LibraryError,
  type BookmarkListData,
  type BookmarkResult,
  type ChannelRecord,
  type FeedPreview,
  type ImportResult,
  type LibraryArticle,
  type LibraryData,
  type ReadResult,
  type SourceChannel,
  type SourceRecord,
  type StoredArticle,
} from "./contracts";
import { contentVersionHash, extractVersionContent, type VersionContent } from "./article-content";
import { itemIdentity } from "./article-identity";
import type { ParsedFeed } from "./rss/types";
import { articleAliases, articleBookmarks, articleReads, articleSources, articles, articleVersions, channels, previewRecords, sources } from "./schema";

export { LibraryError } from "./contracts";
export type { SourceChannel } from "./contracts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Article = typeof articles.$inferSelect;
type Source = typeof sources.$inferSelect;

const PREVIEW_TTL_MS = 20 * 60 * 1000;
const EXPIRED_PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateId(id: string) {
  if (!UUID.test(id)) throw new LibraryError("INVALID_ID", "记录编号无效。");
}

function sourceRecord(source: Source, channelName: string): SourceRecord {
  return {
    id: source.id, name: source.name, feedUrl: source.feedUrl, siteUrl: source.siteUrl,
    channel: source.channel, channelName, lastError: source.lastError,
    lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
  };
}

function channelName(value: string) {
  const name = typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
  if (!name || [...name].length > 24) throw new LibraryError("INVALID_CHANNEL_NAME", "分类名称应为 1–24 个字符。");
  return { name, normalizedName: name.toLowerCase() };
}

async function requireChannel(db: Database | Transaction, id: string): Promise<ChannelRecord> {
  if (typeof id !== "string" || !id || id.length > 64) throw new LibraryError("INVALID_CHANNEL", "请选择有效分类。");
  const [channel] = await db.select({ id: channels.id, name: channels.name }).from(channels).where(eq(channels.id, id));
  if (!channel) throw new LibraryError("INVALID_CHANNEL", "所选分类不存在，请刷新后重试。");
  return channel;
}

export async function createChannel(name: string): Promise<ChannelRecord> {
  const values = channelName(name);
  const [channel] = await getDb().insert(channels).values({ id: randomUUID(), ...values })
    .onConflictDoNothing({ target: channels.normalizedName }).returning({ id: channels.id, name: channels.name });
  if (!channel) throw new LibraryError("CHANNEL_EXISTS", "这个分类名称已经存在。", 409);
  return channel;
}

export async function renameChannel(id: string, name: string): Promise<ChannelRecord> {
  const values = channelName(name);
  if (typeof id !== "string" || !id || id.length > 64) throw new LibraryError("INVALID_CHANNEL", "分类编号无效。");
  try {
    const [channel] = await getDb().update(channels).set(values).where(eq(channels.id, id))
      .returning({ id: channels.id, name: channels.name });
    if (!channel) throw new LibraryError("CHANNEL_NOT_FOUND", "分类不存在。", 404);
    return channel;
  } catch (error) {
    // Drizzle wraps PostgreSQL errors. Only expose our known name conflict.
    let cause: unknown = error;
    while (cause instanceof Error) {
      if ("code" in cause && cause.code === "23505" && "constraint" in cause
        && cause.constraint === "channels_normalized_name_key") {
        throw new LibraryError("CHANNEL_EXISTS", "这个分类名称已经存在。", 409);
      }
      cause = cause.cause;
    }
    throw error;
  }
}

export async function updateSourceChannel(id: string, channelId: string): Promise<SourceRecord> {
  validateId(id);
  return getDb().transaction(async (tx) => {
    const channel = await requireChannel(tx, channelId);
    const [source] = await tx.update(sources).set({ channel: channel.id })
      .where(and(eq(sources.id, id), isNull(sources.deletedAt))).returning();
    if (!source) throw new LibraryError("SOURCE_NOT_FOUND", "信息源不存在。", 404);
    return sourceRecord(source, channel.name);
  });
}

export async function deleteSource(id: string): Promise<{ sourceId: string }> {
  validateId(id);
  return getDb().transaction(async (tx) => {
    // Share the import lock so a fetch already in progress cannot bring a
    // deleted subscription back or write new articles after deletion completes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742619381)`);
    const [source] = await tx.select({ id: sources.id, deletedAt: sources.deletedAt })
      .from(sources).where(eq(sources.id, id)).for("update");
    if (!source) throw new LibraryError("SOURCE_NOT_FOUND", "信息源不存在。", 404);
    if (!source.deletedAt) {
      // Keep attribution and article relationships intact. An explicit new
      // import of the same feed URL can restore this subscription later.
      await tx.update(sources).set({ deletedAt: new Date(), lastError: null }).where(eq(sources.id, id));
    }
    return { sourceId: id };
  });
}

function dateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LibraryError("INVALID_DATE", "订阅内容包含无效时间，请重新预览。");
  }
  return date;
}

export async function createPreview(feed: ParsedFeed): Promise<string> {
  const db = getDb();
  const now = Date.now();
  // Keep recently completed results available for retries while bounding storage
  // of full feed snapshots. Cleanup only touches previews expired over a day ago.
  await db.delete(previewRecords).where(lt(
    previewRecords.expiresAt,
    new Date(now - EXPIRED_PREVIEW_RETENTION_MS),
  ));
  const [preview] = await db.insert(previewRecords).values({
    data: feed,
    expiresAt: new Date(now + PREVIEW_TTL_MS),
  }).returning({ id: previewRecords.id });
  return preview.id;
}

export async function getPreview(previewId: string): Promise<FeedPreview | null> {
  validateId(previewId);
  const [preview] = await getDb().select().from(previewRecords)
    .where(eq(previewRecords.id, previewId));
  if (!preview || preview.expiresAt.getTime() <= Date.now()) return null;
  const { items, ...metadata } = preview.data;
  return { previewId, feed: { ...metadata, itemCount: items.length, items: items.slice(0, 5) } };
}

async function writeFeed(
  tx: Transaction,
  sourceId: string,
  feed: ParsedFeed,
): Promise<ImportResult> {
  const now = new Date();
  const keys = feed.items.map(itemIdentity);
  const urlKeys = keys.filter((key) => key.startsWith("url:"));
  const externalIds = feed.items.map((item) => item.externalId).filter(Boolean);
  const existingRows = keys.length ? await tx.select({ article: articles, membership: articleSources, externalId: articleSources.externalId })
    .from(articles).leftJoin(articleSources, and(
      eq(articleSources.articleId, articles.id), eq(articleSources.sourceId, sourceId),
    )).where(or(
      urlKeys.length ? inArray(articles.identityKey, urlKeys) : undefined,
      and(eq(articleSources.sourceId, sourceId), or(
        inArray(articles.identityKey, keys),
        externalIds.length ? inArray(articleSources.externalId, externalIds) : undefined,
      )),
    )) : [];
  const existing = existingRows.map((row) => row.article);
  const byKey = new Map(existing.map((article) => [article.identityKey, article]));
  const byExternalId = new Map(existingRows.filter((row) => row.externalId)
    .map((row) => [row.externalId!, row.article]));
  const existingIds = new Set(existing.map((article) => article.id));
  const pending = new Map<string, Article>();
  const snapshots = new Map(existingRows.filter((row) => row.membership).map((row) => [row.article.id, row.membership!]));
  const currentIds = existingRows.map((row) => row.membership?.currentVersionId).filter((id): id is string => !!id);
  const currentVersions = currentIds.length ? await tx.select().from(articleVersions)
    .where(inArray(articleVersions.id, currentIds)) : [];
  const contentByArticle = new Map<string, VersionContent>(currentVersions.map((version) => [version.articleId, version]));
  const pendingVersions = new Map<string, VersionContent>();
  const memberships = new Map<string, typeof articleSources.$inferInsert>();
  let damagedTitles = 0;

  for (const item of feed.items) {
    // Some publishers emit valid UTF-8 containing literal replacement characters.
    // Keep the previous snapshot until the source supplies a readable title again.
    if (item.title.includes("\uFFFD")) {
      damagedTitles++;
      continue;
    }
    const incomingKey = itemIdentity(item);
    const guidMatch = item.externalId ? byExternalId.get(item.externalId) : undefined;
    // A GUID fallback can fill a missing permalink, but must not collapse two
    // different article URLs just because a publisher reused a GUID.
    const match = byKey.get(incomingKey) ?? (!item.url || !guidMatch?.url ? guidMatch : undefined);
    const identityKey = !item.url && match?.identityKey.startsWith("url:") ? match.identityKey : incomingKey;
    const articleId = match?.id ?? randomUUID();
    const currentContent = contentByArticle.get(articleId);
    const incomingContent = extractVersionContent(item, feed.language);
    // A source may alternate between full-content and description-only feeds.
    // Keep its saved full text when the latest response has only a summary.
    const acceptContent = incomingContent && !(
      currentContent?.contentKind === "rss_content" && incomingContent.contentKind === "rss_description"
    );
    if (acceptContent) {
      contentByArticle.set(articleId, incomingContent);
      pendingVersions.set(articleId, incomingContent);
    }
    const snapshot = snapshots.get(articleId);
    const primary = !match || match.sourceId === sourceId;
    const snapshotTitle = !acceptContent && currentContent ? currentContent.title : item.title;
    const snapshotSummary = !acceptContent && currentContent ? snapshot?.summary ?? null : item.summary;
    const article: Article = {
      id: articleId, sourceId: match?.sourceId ?? sourceId, identityKey,
      externalId: match && match.sourceId !== sourceId ? match.externalId : item.externalId || match?.externalId || null,
      title: primary ? snapshotTitle : match.title,
      url: match?.url ?? item.url,
      summary: primary ? snapshotSummary : match.summary,
      textContent: primary ? contentByArticle.get(articleId)?.body ?? match?.textContent ?? null : match.textContent,
      currentVersionId: match?.currentVersionId ?? null,
      imageUrl: item.imageUrl ?? match?.imageUrl ?? null,
      author: item.author ?? match?.author ?? null,
      publishedAt: dateOrNull(item.publishedAt) ?? match?.publishedAt ?? null,
      updatedAt: dateOrNull(item.updatedAt) ?? match?.updatedAt ?? null,
      firstSeenAt: match?.firstSeenAt ?? now,
      lastFetchedAt: now,
    };
    pending.set(article.id, article);
    const membership = {
      articleId: article.id, sourceId, externalId: item.externalId || null,
      title: snapshotTitle, summary: snapshotSummary, currentVersionId: snapshot?.currentVersionId ?? null,
    };
    memberships.set(article.id, membership);
    snapshots.set(article.id, membership);
    byKey.set(identityKey, article);
    if (item.externalId) byExternalId.set(item.externalId, article);
  }

  if (pending.size) {
    await tx.insert(articles).values([...pending.values()]).onConflictDoUpdate({
      target: articles.id,
      set: {
        identityKey: sql`excluded.identity_key`, externalId: sql`excluded.external_id`,
        title: sql`excluded.title`, url: sql`excluded.url`, summary: sql`excluded.summary`,
        textContent: sql`excluded.text_content`, imageUrl: sql`excluded.image_url`,
        author: sql`excluded.author`, publishedAt: sql`excluded.published_at`,
        updatedAt: sql`excluded.updated_at`, lastFetchedAt: now,
      },
    });
  }
  if (memberships.size) {
    await tx.insert(articleSources).values([...memberships.values()]).onConflictDoUpdate({
      target: [articleSources.articleId, articleSources.sourceId],
      set: { externalId: sql`coalesce(excluded.external_id, ${articleSources.externalId})`, title: sql`excluded.title`, summary: sql`excluded.summary` },
    });
  }
  if (pendingVersions.size) {
    const versions = [...pendingVersions].map(([articleId, content]) => ({
      articleId, ...content, contentHash: contentVersionHash(content), storedAt: now,
    }));
    // Version rows are insert-only: a repeated snapshot reuses its original id
    // and timestamp, including when a publisher returns to an earlier body.
    await tx.insert(articleVersions).values(versions).onConflictDoNothing({
      target: [articleVersions.articleId, articleVersions.contentHash],
    });
    const savedVersions = await tx.select({
      id: articleVersions.id, articleId: articleVersions.articleId, contentHash: articleVersions.contentHash,
    }).from(articleVersions).where(and(
      inArray(articleVersions.articleId, versions.map((version) => version.articleId)),
      inArray(articleVersions.contentHash, versions.map((version) => version.contentHash)),
    ));
    const versionIds = new Map(savedVersions.map((version) => [`${version.articleId}:${version.contentHash}`, version.id]));
    const pointers = versions.map((version) => {
      const id = versionIds.get(`${version.articleId}:${version.contentHash}`);
      if (!id) throw new Error("文章版本保存失败。");
      return sql`(${version.articleId}::uuid, ${id}::uuid)`;
    });
    await tx.execute(sql`
      UPDATE ${articles} AS a SET current_version_id = v.version_id
      FROM (VALUES ${sql.join(pointers, sql`, `)}) AS v(article_id, version_id)
      WHERE a.id = v.article_id AND a.source_id = ${sourceId}::uuid
    `);
    await tx.execute(sql`UPDATE ${articleSources} AS a SET current_version_id = v.version_id
      FROM (VALUES ${sql.join(pointers, sql`, `)}) AS v(article_id, version_id)
      WHERE a.article_id = v.article_id AND a.source_id = ${sourceId}::uuid`);
  }
  await tx.update(sources).set({
    lastFetchedAt: now,
    lastError: damagedTitles
      ? `上游 RSS 有 ${damagedTitles} 条标题含乱码，本次已跳过，已有文章保持原样。`
      : null,
  })
    .where(eq(sources.id, sourceId));
  const [totals] = await tx.select({ count: count() }).from(articleSources).where(eq(articleSources.sourceId, sourceId));
  const updatedCount = [...pending.keys()].filter((id) => existingIds.has(id)).length;
  return { sourceId, insertedCount: pending.size - updatedCount, updatedCount, totalCount: totals.count };
}

export async function confirmImport(
  previewId: string,
  name: string,
  channel: SourceChannel,
): Promise<ImportResult> {
  validateId(previewId);
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 120) throw new LibraryError("INVALID_NAME", "来源名称应为 1–120 个字符。");

  return getDb().transaction(async (tx) => {
    // Imports are short local DB writes. Serialize them across feeds so two
    // overlapping sources cannot race to create the same canonical article.
    // The global URL unique index is the final database-level safeguard.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742619381)`);
    const [preview] = await tx.select().from(previewRecords)
      .where(eq(previewRecords.id, previewId)).for("update");
    if (!preview) throw new LibraryError("PREVIEW_NOT_FOUND", "预览不存在，请重新获取。", 404);
    // Retrying an already completed operation returns its original result.
    if (preview.result) return preview.result;
    if (preview.expiresAt.getTime() <= Date.now()) throw new LibraryError("PREVIEW_EXPIRED", "预览已过期，请重新获取。", 410);
    await requireChannel(tx, channel);

    const feed = preview.data;
    const [source] = await tx.insert(sources).values({
      name: cleanName, feedUrl: feed.url, siteUrl: feed.siteUrl, channel,
    }).onConflictDoUpdate({
      target: sources.feedUrl,
      set: { name: cleanName, siteUrl: feed.siteUrl, channel, deletedAt: null },
    }).returning();
    // The source upsert holds a row lock, serializing imports for this feed.
    const result = await writeFeed(tx, source.id, feed);
    await tx.update(previewRecords).set({ consumedSourceId: source.id, result })
      .where(eq(previewRecords.id, previewId));
    return result;
  });
}

export async function getSource(id: string): Promise<SourceRecord | null> {
  validateId(id);
  const [row] = await getDb().select({ source: sources, channelName: channels.name }).from(sources)
    .innerJoin(channels, eq(channels.id, sources.channel))
    .where(and(eq(sources.id, id), isNull(sources.deletedAt)));
  return row ? sourceRecord(row.source, row.channelName) : null;
}

export async function importFetchedFeed(sourceId: string, feed: ParsedFeed): Promise<ImportResult> {
  validateId(sourceId);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742619381)`);
    const [source] = await tx.select().from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt))).for("update");
    if (!source) throw new LibraryError("SOURCE_NOT_FOUND", "信息源不存在。", 404);
    return writeFeed(tx, sourceId, feed);
  });
}

export async function recordSourceFailure(sourceId: string, error: string): Promise<void> {
  validateId(sourceId);
  await getDb().update(sources).set({ lastError: error.slice(0, 500) })
    .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)));
}

const libraryArticleColumns = {
  id: articles.id, sourceId: sources.id, sourceName: sources.name,
  sourceIds: sql<string[]>`(SELECT coalesce(json_agg(m.source_id ORDER BY m.source_id), '[]'::json)
    FROM article_sources m WHERE m.article_id = ${articles.id})`,
  title: sql<string>`coalesce(${articleSources.title}, CASE WHEN ${sources.id} = ${articles.sourceId} THEN ${articles.title} ELSE '文章内容待同步' END)`, url: articles.url,
  summary: articleSources.summary,
  imageUrl: articles.imageUrl, author: articles.author,
  publishedAt: articles.publishedAt, firstSeenAt: articles.firstSeenAt, channel: sources.channel,
  channelName: channels.name,
  bookmarkedAt: articleBookmarks.bookmarkedAt,
  readAt: articleReads.readAt,
};

function serializeArticle(article: Omit<LibraryArticle, "publishedAt" | "firstSeenAt" | "bookmarkedAt" | "readAt"> & {
  publishedAt: Date | null;
  firstSeenAt: Date;
  bookmarkedAt: Date | null;
  readAt: Date | null;
}): LibraryArticle {
  return {
    ...article,
    publishedAt: article.publishedAt?.toISOString() ?? null,
    firstSeenAt: article.firstSeenAt.toISOString(),
    bookmarkedAt: article.bookmarkedAt?.toISOString() ?? null,
    readAt: article.readAt?.toISOString() ?? null,
  };
}

export async function getStoredArticle(id: string, sourceId?: string): Promise<StoredArticle | null> {
  if (sourceId) validateId(sourceId);
  validateId(id);
  id = await resolveArticleId(getDb(), id);
  const [row] = await getDb().select({ article: libraryArticleColumns, version: articleVersions })
    .from(articles).innerJoin(articleSources, and(eq(articleSources.articleId, articles.id), sourceId ? eq(articleSources.sourceId, sourceId) : eq(articleSources.sourceId, articles.sourceId)))
    .innerJoin(sources, eq(sources.id, articleSources.sourceId))
    .innerJoin(channels, eq(channels.id, sources.channel))
    .leftJoin(articleVersions, and(eq(articleVersions.id, articleSources.currentVersionId), eq(articleVersions.articleId, articles.id)))
    .leftJoin(articleBookmarks, eq(articleBookmarks.articleId, articles.id))
    .leftJoin(articleReads, eq(articleReads.articleId, articles.id))
    .where(eq(articles.id, id));
  if (!row) return null;
  const version = row.version;
  return {
    ...serializeArticle(row.article),
    version: version ? {
      id: version.id, title: version.title, body: version.body, contentKind: version.contentKind,
      language: version.language, contentHash: version.contentHash, storedAt: version.storedAt.toISOString(),
    } : null,
  };
}

export async function listLibrary(options: { channel?: string; source?: string } = {}): Promise<LibraryData> {
  const db = getDb();
  const [sourceRows, totals, bookmarkTotals, channelRows] = await Promise.all([
    db.select({ source: sources, channelName: channels.name, articleCount: count(articleSources.articleId) }).from(sources)
      .innerJoin(channels, eq(channels.id, sources.channel))
      .leftJoin(articleSources, eq(articleSources.sourceId, sources.id))
      .where(isNull(sources.deletedAt)).groupBy(sources.id, channels.id).orderBy(asc(sources.name)),
    db.select({ count: count() }).from(articles),
    db.select({ count: count() }).from(articleBookmarks),
    db.select({ id: channels.id, name: channels.name }).from(channels)
      .orderBy(sql`CASE ${channels.id} WHEN 'literature' THEN 0 WHEN 'anime' THEN 1 WHEN 'world' THEN 2 ELSE 3 END`, asc(channels.createdAt), asc(channels.id)),
  ]);
  const channel = channelRows.some((row) => row.id === options.channel) ? options.channel : undefined;
  const source = sourceRows.find((row) => row.source.id === options.source
    && (!channel || row.source.channel === channel))?.source.id;
  // Apply the selected scope before limiting the feed. Keep a saved article in
  // its original category after source deletion, and include active secondary
  // sources without multiplying articles shared by several subscriptions.
  const scope = and(
    channel ? or(eq(sources.channel, channel), sql`EXISTS (
      SELECT 1 FROM article_sources membership
      JOIN sources associated ON associated.id = membership.source_id
      WHERE membership.article_id = ${articles.id}
        AND associated.channel = ${channel} AND associated.deleted_at IS NULL
    )`) : undefined,
    source ? or(eq(articles.sourceId, source), sql`EXISTS (
      SELECT 1 FROM article_sources membership
      WHERE membership.article_id = ${articles.id} AND membership.source_id = ${source}::uuid
    )`) : undefined,
  );
  const selectedSource = source ? sql`${source}::uuid` : sql`coalesce((
    SELECT membership.source_id FROM article_sources membership
    JOIN sources associated ON associated.id = membership.source_id
    WHERE membership.article_id = ${articles.id} AND associated.deleted_at IS NULL
      ${channel ? sql`AND associated.channel = ${channel}` : sql``}
    ORDER BY (membership.source_id = ${articles.sourceId}) DESC, membership.source_id
    LIMIT 1
  ), ${articles.sourceId})`;
  const [articleRows, scopedTotals] = await Promise.all([
    db.select(libraryArticleColumns)
      .from(articles).innerJoin(articleSources, and(eq(articleSources.articleId, articles.id), eq(articleSources.sourceId, selectedSource)))
      .innerJoin(sources, eq(articleSources.sourceId, sources.id))
      .innerJoin(channels, eq(channels.id, sources.channel))
      .leftJoin(articleBookmarks, eq(articleBookmarks.articleId, articles.id))
      .leftJoin(articleReads, eq(articleReads.articleId, articles.id))
      .where(scope)
      .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.firstSeenAt})`), desc(articles.id)).limit(100),
    channel || source
      ? db.select({ count: count() }).from(articles)
        .innerJoin(sources, eq(articles.sourceId, sources.id)).where(scope)
      : Promise.resolve(totals),
  ]);
  return {
    channels: channelRows,
    sources: sourceRows.map(({ source, channelName, articleCount }) => ({ ...sourceRecord(source, channelName), articleCount })),
    articles: articleRows.map(serializeArticle),
    articleCount: scopedTotals[0].count,
    counts: { sources: sourceRows.length, articles: totals[0].count, bookmarks: bookmarkTotals[0].count },
  };
}

async function resolveArticleId(db: Database | Transaction, id: string): Promise<string> {
  const [alias] = await db.select({ articleId: articleAliases.articleId }).from(articleAliases)
    .where(eq(articleAliases.aliasId, id));
  return alias?.articleId ?? id;
}

export async function setArticleRead(articleId: string, read: boolean): Promise<ReadResult> {
  validateId(articleId);
  if (typeof read !== "boolean") throw new LibraryError("INVALID_READ", "请指定文章阅读状态。");
  return getDb().transaction(async (tx) => {
    articleId = await resolveArticleId(tx, articleId);
    const [article] = await tx.select({ id: articles.id }).from(articles)
      .where(eq(articles.id, articleId)).for("update");
    if (!article) throw new LibraryError("ARTICLE_NOT_FOUND", "文章不存在。", 404);
    if (!read) {
      await tx.delete(articleReads).where(eq(articleReads.articleId, article.id));
      return { articleId: article.id, readAt: null };
    }
    await tx.insert(articleReads).values({ articleId: article.id }).onConflictDoNothing();
    const [state] = await tx.select().from(articleReads).where(eq(articleReads.articleId, article.id));
    return { articleId: article.id, readAt: state.readAt.toISOString() };
  });
}

export async function setArticleBookmark(articleId: string, bookmarked: boolean): Promise<BookmarkResult> {
  validateId(articleId);
  if (typeof bookmarked !== "boolean") throw new LibraryError("INVALID_BOOKMARK", "请指定是否收藏文章。");
  return getDb().transaction(async (tx) => {
    articleId = await resolveArticleId(tx, articleId);
    // The article always exists even when its bookmark does not, so this lock
    // serializes both additions and removals without changing feed contents.
    const [article] = await tx.select({ id: articles.id }).from(articles)
      .where(eq(articles.id, articleId)).for("update");
    if (!article) throw new LibraryError("ARTICLE_NOT_FOUND", "文章不存在。", 404);
    if (!bookmarked) {
      await tx.delete(articleBookmarks).where(eq(articleBookmarks.articleId, article.id));
      return { articleId: article.id, bookmarkedAt: null };
    }
    await tx.insert(articleBookmarks).values({ articleId: article.id }).onConflictDoNothing();
    const [bookmark] = await tx.select().from(articleBookmarks)
      .where(eq(articleBookmarks.articleId, article.id));
    return { articleId: article.id, bookmarkedAt: bookmark.bookmarkedAt.toISOString() };
  });
}

const BOOKMARK_PAGE_SIZE = 30;
type BookmarkCursor = { time: string; id: string };

function parseBookmarkCursor(value: string | null | undefined): BookmarkCursor | null {
  if (value == null) return null;
  try {
    if (!value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [time, id] = parsed;
    if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(time)
      || typeof id !== "string" || !UUID.test(id)) throw new Error();
    if (time.startsWith("0000") || new Date(time).toISOString() !== `${time.slice(0, 23)}Z`) throw new Error();
    return { time, id };
  } catch {
    throw new LibraryError("INVALID_CURSOR", "收藏列表位置无效，请重新打开收藏列表。");
  }
}

export async function listBookmarks(cursor?: string | null): Promise<BookmarkListData> {
  const position = parseBookmarkCursor(cursor);
  const db = getDb();
  const [rows, totals] = await Promise.all([
    db.select({
      article: libraryArticleColumns,
      // JS Dates truncate microseconds; preserve the database sort value in
      // the opaque cursor so the next page compares exactly the same tuple.
      cursorTime: sql<string>`to_char(${articleBookmarks.bookmarkedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(articleBookmarks)
      .innerJoin(articles, eq(articles.id, articleBookmarks.articleId))
      .innerJoin(sources, eq(sources.id, articles.sourceId))
      .innerJoin(articleSources, and(eq(articleSources.articleId, articles.id), eq(articleSources.sourceId, articles.sourceId)))
      .innerJoin(channels, eq(channels.id, sources.channel))
      .leftJoin(articleReads, eq(articleReads.articleId, articles.id))
      .where(position ? sql`(${articleBookmarks.bookmarkedAt}, ${articleBookmarks.articleId}) < (${position.time}::timestamptz, ${position.id}::uuid)` : undefined)
      .orderBy(desc(articleBookmarks.bookmarkedAt), desc(articleBookmarks.articleId)).limit(BOOKMARK_PAGE_SIZE + 1),
    db.select({ count: count() }).from(articleBookmarks),
  ]);
  const visible = rows.slice(0, BOOKMARK_PAGE_SIZE);
  const last = visible.at(-1);
  return {
    articles: visible.map(({ article }) => serializeArticle(article)),
    total: totals[0].count,
    nextCursor: rows.length > BOOKMARK_PAGE_SIZE && last
      ? Buffer.from(JSON.stringify([last.cursorTime, last.article.id])).toString("base64url") : null,
  };
}
