import { z } from "zod";
import { deleteSource, updateSource } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({
  name: z.string().trim().min(1, "请输入来源名称。").max(120, "来源名称应为 1–120 个字符。").optional(),
  feedUrl: z.string().trim().min(1, "请输入订阅地址。").max(2048, "订阅地址过长。").optional(),
  channel: z.string().min(1, "请选择所属分类。").max(64, "所选分类无效。").optional(),
}).strict().refine(value => Object.keys(value).length > 0, "请填写需要修改的信息。");

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    const changes = await readBody(request, input);
    return json({ source: await updateSource(id, changes) });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    return json(await deleteSource(id));
  } catch (error) { return apiError(error); }
}
