import { z } from "zod";
import { apiError, authorize, json, readBody } from "@/lib/http";
import { getReaderSettings, updateReaderSettings } from "@/lib/reader-settings";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await authorize(request);
    return json(await getReaderSettings());
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    await authorize(request, true);
    const input = await readBody(request, z.object({
      sort: z.enum(["published", "collected"], { error: "请选择有效的排序方式。" }),
    }).strict());
    return json(await updateReaderSettings(input.sort));
  } catch (error) { return apiError(error); }
}
