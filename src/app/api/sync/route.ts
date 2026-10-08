import { z } from "zod";
import { apiError, authorize, json, readBody } from "@/lib/http";
import { getSyncStatus, updateSyncSettings } from "@/lib/sync";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await authorize(request);
    return json(await getSyncStatus());
  } catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    await authorize(request, true);
    const input = await readBody(request, z.object({
      enabled: z.boolean(), intervalMinutes: z.number().int(),
    }).strict());
    return json(await updateSyncSettings(input));
  } catch (error) { return apiError(error); }
}
