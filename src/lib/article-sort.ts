export type ArticleSort = "published" | "collected";

export function normalizeArticleSort(value: unknown): ArticleSort {
  return value === "collected" ? "collected" : "published";
}
