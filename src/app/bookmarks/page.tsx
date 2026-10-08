import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import BookmarksApp from "@/components/bookmarks-app";
import { hasOwnerSession, isLocalDevelopment } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata: Metadata = { title: "我的收藏 · 大象" };

export default async function BookmarksPage() {
  if (!isLocalDevelopment()) {
    if (!process.env.ADMIN_EMAIL || !process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) {
      return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
        <h1>大象</h1><p>请先配置数据库与管理员，再打开收藏。</p>
      </main>;
    }
    if (!await hasOwnerSession(await headers())) redirect("/login");
  }
  return <BookmarksApp />;
}
