import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { getPool } from "../src/lib/db";
import { runDueSync } from "../src/lib/sync";

export async function startSyncWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try { await runDueSync(); }
    catch (error) {
      // Do not print connection strings or upstream payloads to process logs.
      console.error("RSS sync worker failed:", error instanceof Error ? error.name : "UnknownError");
    }
    if (signal.aborted) break;
    try { await setTimeout(60_000, undefined, { signal }); }
    catch { if (!signal.aborted) throw new Error("RSS worker timer failed"); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await startSyncWorker(controller.signal).finally(() => getPool().end());
}
