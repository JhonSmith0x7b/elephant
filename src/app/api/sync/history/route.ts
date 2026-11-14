import { apiError, authorize, json } from "@/lib/http";
import { getSyncHistory } from "@/lib/sync";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await authorize(request);
    return json(await getSyncHistory());
  } catch (error) { return apiError(error); }
}
