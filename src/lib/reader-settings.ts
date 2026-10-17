import { getPool } from "./db";
import type { ArticleSort } from "./article-sort";

export async function getReaderSettings(): Promise<{ sort: ArticleSort }> {
  const { rows } = await getPool().query<{ sort: ArticleSort }>(
    "SELECT article_sort AS sort FROM reader_settings WHERE id = true",
  );
  if (!rows[0]) throw new Error("请先完成数据库初始化。");
  return rows[0];
}

export async function updateReaderSettings(sort: ArticleSort): Promise<{ sort: ArticleSort }> {
  const { rows } = await getPool().query<{ sort: ArticleSort }>(
    "UPDATE reader_settings SET article_sort = $1 WHERE id = true RETURNING article_sort AS sort",
    [sort],
  );
  if (!rows[0]) throw new Error("请先完成数据库初始化。");
  return rows[0];
}
