import { listLibrary } from "@/lib/library";
import { apiError, authorize, json, RequestError } from "@/lib/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    await authorize(request);
    const params = new URL(request.url).searchParams;
    const sort = params.get("sort");
    if (sort !== null && sort !== "published" && sort !== "collected") {
      throw new RequestError("请选择有效的排序方式。");
    }
    return json(await listLibrary({ channel: params.get("channel") ?? undefined, source: params.get("source") ?? undefined, cursor: params.get("cursor"), sort: sort ?? undefined }));
  }
  catch (error) { return apiError(error); }
}
