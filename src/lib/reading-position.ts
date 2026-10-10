export interface ReadingPosition { articleId: string; title: string; savedAt: number }
export const READING_POSITIONS_KEY = "elephant-reading-positions";

export function parseReadingPositions(raw: string | null): Record<string, ReadingPosition> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([scope, item]) =>
      scope.length <= 1000 && item && typeof item === "object" &&
      typeof item.articleId === "string" && item.articleId.length > 0 && item.articleId.length <= 200 &&
      typeof item.title === "string" && item.title.length <= 2000 &&
      typeof item.savedAt === "number" && Number.isFinite(item.savedAt),
    ).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 60));
  } catch { return {}; }
}

export function saveReadingPosition(scope: string, position: ReadingPosition) {
  try {
    const positions = parseReadingPositions(localStorage.getItem(READING_POSITIONS_KEY));
    localStorage.setItem(READING_POSITIONS_KEY, JSON.stringify(parseReadingPositions(JSON.stringify({ ...positions, [scope]: position }))));
  } catch { /* Private browsing or full storage must not interrupt reading. */ }
}
