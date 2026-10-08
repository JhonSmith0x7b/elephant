import { listBookmarks } from "@/lib/library";
import { apiError, authorize, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await authorize(request);
    return json(await listBookmarks(new URL(request.url).searchParams.get("cursor")));
  } catch (error) { return apiError(error); }
}
