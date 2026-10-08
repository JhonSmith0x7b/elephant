import { z } from "zod";
import { setArticleRead } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({ read: z.boolean({ error: "请指定文章阅读状态。" }) });

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    const { read } = await readBody(request, input);
    return json(await setArticleRead(id, read));
  } catch (error) { return apiError(error); }
}
