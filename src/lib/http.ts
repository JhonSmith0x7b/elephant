import { z } from "zod";
import { hasOwnerSession, isLocalDevelopment } from "./auth";

export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function authorize(request: Request, mutation = false) {
  const url = new URL(request.url);
  if (mutation) {
    const origin = request.headers.get("origin");
    const allowed = [url.origin];
    // Next's local server may normalize its request URL to localhost even
    // when the browser opened 127.0.0.1. Limit aliases to the same local port.
    if (isLocalDevelopment() && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
        const alias = new URL(url.origin);
        alias.hostname = hostname;
        allowed.push(alias.origin);
      }
    }
    if (process.env.BETTER_AUTH_URL) allowed.push(new URL(process.env.BETTER_AUTH_URL).origin);
    if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && !allowed.includes(origin))) {
      throw new RequestError("请在大象页面中操作。", 403);
    }
  }
  if (isLocalDevelopment() && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  if (!process.env.ADMIN_EMAIL || !process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) {
    throw new RequestError("请先配置管理员并完成数据库初始化。", 503);
  }
  if (!await hasOwnerSession(request.headers)) throw new RequestError("请先登录大象。", 401);
}

export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new RequestError("请使用 JSON 提交请求。", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError("请求内容为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new RequestError("提交内容过长。", 413); }
    chunks.push(value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError("请求格式不正确。"); }
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(result.error.issues[0]?.message ?? "请检查输入内容。");
  return result.data;
}

export function apiError(error: unknown) {
  if (error instanceof RequestError) return json({ error: error.message }, error.status);
  if (error instanceof Error && ["RssError", "LibraryError"].includes(error.name)) {
    const status = "status" in error && typeof error.status === "number" ? error.status : 400;
    return json({ error: error.message }, status);
  }
  // Avoid exposing database connection strings or upstream internals to the browser/logs.
  console.error("Reader request failed", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "暂时无法完成操作，请检查数据库连接后重试。" }, 500);
}
