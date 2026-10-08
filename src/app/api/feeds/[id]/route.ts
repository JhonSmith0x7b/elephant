import { z } from "zod";
import { deleteSource, updateSourceChannel } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({ channel: z.string().min(1, "请选择所属分类。").max(64, "所选分类无效。") });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    const { channel } = await readBody(request, input);
    return json({ source: await updateSourceChannel(id, channel) });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    return json(await deleteSource(id));
  } catch (error) { return apiError(error); }
}
