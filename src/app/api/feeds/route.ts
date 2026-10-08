import { z } from "zod";
import { confirmImport } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({
  previewId: z.uuid("预览已失效，请重新预览。"),
  name: z.string().trim().min(1, "请填写来源名称。").max(120, "来源名称最多 120 字。"),
  channel: z.string().min(1, "请选择所属分类。").max(64, "所选分类无效。"),
});

export async function POST(request: Request) {
  try {
    await authorize(request, true);
    const { previewId, name, channel } = await readBody(request, input);
    return json(await confirmImport(previewId, name, channel));
  } catch (error) { return apiError(error); }
}
