import { z } from "zod";
import { renameChannel } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({ name: z.string().max(240, "分类名称应为 1–24 个字符。") });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    const { name } = await readBody(request, input);
    return json({ channel: await renameChannel(id, name) });
  } catch (error) { return apiError(error); }
}
