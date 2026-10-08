export const MAX_SELECTION_LENGTH = 300;

function shorten(text: string, limit: number): string {
  const characters = Array.from(text.trim());
  return characters.length > limit
    ? `${characters.slice(0, limit - 1).join("")}…`
    : characters.join("");
}

export function buildAiModeUrl({
  text,
  title,
  context,
}: {
  text: string;
  title?: string;
  context?: string;
}): string {
  const selectedText = text.trim();
  if (!selectedText || Array.from(selectedText).length > MAX_SELECTION_LENGTH) {
    throw new Error(`请选择 1 至 ${MAX_SELECTION_LENGTH} 个字进行查询。`);
  }

  let question = `请用简体中文解释以下内容，补充必要背景：\n「${selectedText}」`;
  const excerpt = context?.trim();
  if (excerpt) {
    const articleTitle = title?.trim();
    question += "\n\n请结合以下文章信息理解所选内容：";
    if (articleTitle) question += `\n文章标题：${shorten(articleTitle, 100)}`;
    question += `\n上下文：${shorten(excerpt, 240)}`;
  }

  const url = new URL("https://www.google.com/search");
  url.search = new URLSearchParams({ udm: "50", q: question }).toString();
  return url.toString();
}
