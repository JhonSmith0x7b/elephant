import Link from "next/link";

export default function ArticleNotFound() {
  return <main style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
    <h1>没有找到这篇文章</h1>
    <p>这条链接对应的内容尚未收录，或已经不存在。</p>
    <Link href="/">返回信息流</Link>
  </main>;
}
