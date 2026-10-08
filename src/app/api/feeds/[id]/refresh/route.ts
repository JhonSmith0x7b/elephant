import { z } from "zod";
import { previewFeed } from "@/lib/rss";
import { getSource, importFetchedFeed, recordSourceFailure } from "@/lib/library";
import { apiError, authorize, json, RequestError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await authorize(request, true);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) throw new RequestError("来源不存在。", 404);
    const source = await getSource(id);
    if (!source) throw new RequestError("来源不存在。", 404);
    try {
      return json(await importFetchedFeed(id, await previewFeed(source.feedUrl)));
    } catch (error) {
      const reason = error instanceof Error && error.name === "RssError" ? error.message : "刷新失败，请稍后重试。";
      await recordSourceFailure(id, reason);
      throw error;
    }
  } catch (error) { return apiError(error); }
}
