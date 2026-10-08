import { z } from "zod";
import { previewFeed } from "@/lib/rss";
import { createPreview } from "@/lib/library";
import { apiError, authorize, json, readBody } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
const input = z.object({ url: z.string().trim().min(1, "请输入 RSS 地址。").max(2048, "地址过长。") });

export async function POST(request: Request) {
  try {
    await authorize(request, true);
    const { url } = await readBody(request, input);
    const feed = await previewFeed(url);
    const previewId = await createPreview(feed);
    return json({ previewId, feed: { ...feed, itemCount: feed.items.length, items: feed.items.slice(0, 3).map(({ title, url, publishedAt, summary, imageUrl }) => ({ title, url, publishedAt, summary, imageUrl })) } });
  } catch (error) { return apiError(error); }
}
