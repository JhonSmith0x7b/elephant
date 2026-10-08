import { z } from "zod";
import { createChannel } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
const input = z.object({ name: z.string().max(240, "分类名称应为 1–24 个字符。") });

export async function POST(request: Request) {
  try {
    await authorize(request, true);
    const { name } = await readBody(request, input);
    return json({ channel: await createChannel(name) }, 201);
  } catch (error) { return apiError(error); }
}
