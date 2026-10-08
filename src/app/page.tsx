import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ReaderApp from "@/components/reader-app";
import { hasOwnerSession, isLocalDevelopment } from "@/lib/auth";

export const dynamic = "force-dynamic";
export default async function Home() {
  if (!isLocalDevelopment()) {
    if (!process.env.ADMIN_EMAIL || !process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) {
      return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}><h1>大象</h1><p>请先配置数据库与管理员，再打开大象。</p><p>按照项目 README 完成初始化即可。当前内容未公开。</p></main>;
    }
    if (!await hasOwnerSession(await headers())) redirect("/login");
  }
  return <ReaderApp />;
}
