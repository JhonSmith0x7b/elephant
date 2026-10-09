import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { ContentKind, ImportResult, SourceChannel } from "./contracts";
import type { ParsedFeed } from "./rss/types";

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  feedUrl: text("feed_url").notNull().unique(),
  siteUrl: text("site_url"),
  channel: text("channel").$type<SourceChannel>().notNull().references(() => channels.id),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastError: text("last_error"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [index("sources_channel_idx").on(table.channel)]);

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    identityKey: text("identity_key").notNull(),
    externalId: text("external_id"),
    title: text("title").notNull(),
    url: text("url"),
    summary: text("summary"),
    textContent: text("text_content"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => articleVersions.id, { onDelete: "set null" }),
    imageUrl: text("image_url"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("articles_source_identity_key").on(table.sourceId, table.identityKey),
    uniqueIndex("articles_url_identity_key").on(table.identityKey).where(sql`${table.identityKey} LIKE 'url:%'`),
    index("articles_source_id_idx").on(table.sourceId),
    index("articles_published_at_idx").on(table.publishedAt),
    index("articles_current_version_id_idx").on(table.currentVersionId),
  ],
);

export const articleSources = pgTable("article_sources", {
  title: text("title"),
  summary: text("summary"),
  currentVersionId: uuid("current_version_id").references((): AnyPgColumn => articleVersions.id, { onDelete: "set null" }),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  externalId: text("external_id"),
}, (table) => [
  primaryKey({ columns: [table.articleId, table.sourceId] }),
  index("article_sources_source_id_idx").on(table.sourceId),
]);

export const articleAliases = pgTable("article_aliases", {
  aliasId: uuid("alias_id").primaryKey(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
}, (table) => [index("article_aliases_article_id_idx").on(table.articleId)]);

export const articleVersions = pgTable("article_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  contentKind: text("content_kind").$type<ContentKind>().notNull(),
  language: text("language"),
  contentHash: text("content_hash").notNull(),
  storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("article_versions_article_hash_key").on(table.articleId, table.contentHash)]);

export const articleBookmarks = pgTable("article_bookmarks", {
  articleId: uuid("article_id").primaryKey().references(() => articles.id, { onDelete: "cascade" }),
  bookmarkedAt: timestamp("bookmarked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("article_bookmarks_time_id_idx").on(table.bookmarkedAt.desc(), table.articleId.desc())]);

export const articleReads = pgTable("article_reads", {
  articleId: uuid("article_id").primaryKey().references(() => articles.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
});


export const previewRecords = pgTable("preview_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  data: jsonb("data").$type<ParsedFeed>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedSourceId: uuid("consumed_source_id").references(() => sources.id, { onDelete: "set null" }),
  result: jsonb("result").$type<ImportResult>(),
}, (table) => [index("preview_records_expires_at_idx").on(table.expiresAt)]);
