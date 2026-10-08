import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { authorize, readBody, RequestError } from "../src/lib/http";

const original = { ...process.env };
after(() => { process.env = original; });

test("local development access requires explicit loopback-only opt-in", async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.LOCAL_DEV_AUTH_BYPASS = "1";
  delete process.env.VERCEL;
  delete process.env.ADMIN_EMAIL;
  delete process.env.BETTER_AUTH_URL;
  await authorize(new Request("http://127.0.0.1:3000/api/library"));
  await assert.rejects(authorize(new Request("https://public.example/api/library")), (error: unknown) => error instanceof RequestError && error.status === 503);
  process.env.VERCEL = "1";
  await assert.rejects(authorize(new Request("http://127.0.0.1:3000/api/library")), (error: unknown) => error instanceof RequestError && error.status === 503);
  delete process.env.VERCEL;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  await assert.rejects(authorize(new Request("http://127.0.0.1:3000/api/library")), (error: unknown) => error instanceof RequestError && error.status === 503);
});

test("mutating requests reject foreign origins before accessing the database", async () => {
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  process.env.LOCAL_DEV_AUTH_BYPASS = "1";
  await authorize(new Request("http://localhost:3000/api/feeds", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } }), true);
  await assert.rejects(authorize(new Request("http://127.0.0.1:3000/api/feeds", { method: "POST", headers: { origin: "https://other.example" } }), true), (error: unknown) => error instanceof RequestError && error.status === 403);
  await assert.rejects(authorize(new Request("http://localhost:3000/api/feeds", { method: "POST", headers: { origin: "http://127.0.0.1:4000" } }), true), (error: unknown) => error instanceof RequestError && error.status === 403);
});

test("JSON request parsing enforces size and schema", async () => {
  const input = z.object({ url: z.string().min(1) });
  const request = (body: string) => new Request("http://127.0.0.1:3000/api/feeds", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.deepEqual(await readBody(request('{"url":"https://lithub.com/feed/"}'), input), { url: "https://lithub.com/feed/" });
  await assert.rejects(readBody(request("not-json"), input), RequestError);
  await assert.rejects(readBody(request('{"url":""}'), input), RequestError);
  await assert.rejects(readBody(request("a".repeat(8193)), input), (error: unknown) => error instanceof RequestError && error.status === 413);
});
