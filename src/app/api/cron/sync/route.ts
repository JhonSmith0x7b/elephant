import { timingSafeEqual } from "node:crypto";
import { apiError, json, RequestError } from "@/lib/http";
import { runDueSync } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 240;

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new RequestError("后台同步触发器尚未配置。", 503);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new RequestError("同步触发凭据无效。", 401);
    }
    return json({ status: await runDueSync() });
  } catch (error) { return apiError(error); }
}
