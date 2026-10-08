import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import StoredArticleView from "@/components/stored-article";
import { hasOwnerSession, isLocalDevelopment } from "@/lib/auth";
import { getStoredArticle } from "@/lib/library";
import { feedReturnHref } from "@/lib/feed-location";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = { title: "已保存文章 · 大象" };

export default async function ArticlePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  // Check access before reading any private saved content from the database.
  if (!isLocalDevelopment()) {
    if (!process.env.ADMIN_EMAIL || !process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) {
      return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
        <h1>大象</h1><p>请先配置数据库与管理员，再打开已保存文章。</p>
      </main>;
    }
    if (!await hasOwnerSession(await headers())) redirect("/login");
  }
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const article = await getStoredArticle(id);
  if (!article) notFound();
  const query = await searchParams;
  return <StoredArticleView article={article} returnTo={feedReturnHref(query.from)} />;
}
