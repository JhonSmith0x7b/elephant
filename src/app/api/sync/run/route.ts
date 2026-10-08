import { apiError, authorize, json } from "@/lib/http";
import { runDueSync } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 240;

export async function POST(request: Request) {
  try {
    await authorize(request, true);
    return json({ status: await runDueSync({ force: true }) });
  } catch (error) { return apiError(error); }
}
