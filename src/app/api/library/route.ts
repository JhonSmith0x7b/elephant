import { listLibrary } from "@/lib/library";
import { apiError, authorize, json } from "@/lib/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    await authorize(request);
    const params = new URL(request.url).searchParams;
    return json(await listLibrary({ channel: params.get("channel") ?? undefined, source: params.get("source") ?? undefined }));
  }
  catch (error) { return apiError(error); }
}
