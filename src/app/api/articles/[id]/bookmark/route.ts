import { z } from "zod";
import { setArticleBookmark } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({ bookmarked: z.boolean({ error: "请指定是否收藏文章。" }) });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    const { bookmarked } = await readBody(request, input);
    return json(await setArticleBookmark(id, bookmarked));
  } catch (error) { return apiError(error); }
}
