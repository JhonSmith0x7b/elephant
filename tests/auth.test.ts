import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { createAuth, getAuth, hasOwnerSession } from "../src/lib/auth";
import { getPool } from "../src/lib/db";
import { authorize, RequestError } from "../src/lib/http";

const environmentKeys = [
  "DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "ADMIN_EMAIL",
  "NODE_ENV", "VERCEL", "LOCAL_DEV_AUTH_BYPASS",
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
const originalDatabaseUrl = process.env.DATABASE_URL;
const schemaName = `rss_auth_test_${randomUUID().replaceAll("-", "")}`;
const origin = "https://reader.example.test";
const email = `owner-${randomUUID()}@example.test`;
const password = randomBytes(24).toString("base64url");

function authRequest(path: string, body: Record<string, unknown>) {
  return new Request(`${origin}/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "X-Forwarded-For": "198.51.100.7" },
    body: JSON.stringify(body),
  });
}

describe("Private reader authentication against an isolated PostgreSQL schema", { skip: !originalDatabaseUrl }, () => {
  let admin: Pool | undefined;
  let appPool: Pool | undefined;
  let schemaCreated = false;

  before(async () => {
    admin = new Pool({ connectionString: originalDatabaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    const testUrl = new URL(originalDatabaseUrl!);
    testUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    Object.assign(process.env, {
      DATABASE_URL: testUrl.toString(),
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: origin,
      // Match setup-auth's normalization while exercising the owner allowlist fix.
      ADMIN_EMAIL: `  ${email.toUpperCase()}  `,
      NODE_ENV: "test",
      VERCEL: "1",
      LOCAL_DEV_AUTH_BYPASS: "1",
    });
    appPool = getPool();
    const current = await appPool.query("SELECT current_schema() AS name");
    assert.equal(current.rows[0].name, schemaName);
    const initializationAuth = createAuth(true);
    const migration = await getMigrations(initializationAuth.options);
    await migration.runMigrations();
    await initializationAuth.api.signUpEmail({ body: {
      email: process.env.ADMIN_EMAIL!.trim().toLowerCase(),
      password,
      name: "Integration test owner",
    } });
  });

  after(async () => {
    try {
      await appPool?.end();
      if (schemaCreated) await admin?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await admin?.end();
      for (const key of environmentKeys) {
        const original = originalEnvironment[key];
        if (original === undefined) Reflect.deleteProperty(process.env, key);
        else Object.assign(process.env, { [key]: original });
      }
    }
  });

  it("migrates the Better Auth tables and initializes an administrator in this schema only", async () => {
    const tables = await appPool!.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
      [schemaName],
    );
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const name of ["user", "session", "account", "verification", "rateLimit"]) {
      assert.ok(names.has(name), `Missing migrated table: ${name}`);
    }
    const users = await appPool!.query('SELECT count(*)::int AS count FROM "user" WHERE email = $1', [email]);
    assert.equal(users.rows[0].count, 1);
  });

  it("rejects public registration without creating an additional user", async () => {
    const response = await getAuth().handler(authRequest("sign-up/email", {
      email: `other-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "Uninvited reader",
    }));
    assert.equal(response.status, 400);
    const users = await appPool!.query('SELECT count(*)::int AS count FROM "user"');
    assert.equal(users.rows[0].count, 1);
  });

  it("accepts the signed-in owner's cookie for session and business API authorization", async () => {
    const response = await getAuth().handler(authRequest("sign-in/email", { email, password }));
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie.length > 0, "A successful sign-in must issue a session cookie");
    const headers = new Headers({ Cookie: cookie, Origin: origin });
    assert.equal(await hasOwnerSession(headers), true);
    await assert.doesNotReject(authorize(new Request(`${origin}/api/library`, { headers })));
    await assert.doesNotReject(authorize(new Request(`${origin}/api/feeds`, {
      method: "POST", headers,
    }), true));
    // An authenticated account still cannot access another configured owner's data.
    const owner = process.env.ADMIN_EMAIL;
    try {
      process.env.ADMIN_EMAIL = `different-${randomUUID()}@example.test`;
      assert.equal(await hasOwnerSession(headers), false);
    } finally { process.env.ADMIN_EMAIL = owner; }
  });

  it("rejects anonymous business requests even with a local bypass flag on Vercel", async () => {
    assert.equal(await hasOwnerSession(new Headers()), false);
    await assert.rejects(authorize(new Request(`${origin}/api/library`)),
      (error: unknown) => error instanceof RequestError && error.status === 401);
    await assert.rejects(authorize(new Request("http://localhost:3000/api/library")),
      (error: unknown) => error instanceof RequestError && error.status === 401);
  });

  it("issues a one-year cookie and renews a valid legacy session through HTTP, not permission checks", async () => {
    const response = await getAuth().handler(authRequest("sign-in/email", { email, password }));
    assert.equal(response.status, 200);
    const sessionCookie = response.headers.getSetCookie().find(value => value.includes("session_token="));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /Max-Age=31536000/i);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Secure/i);
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const session = await getAuth().api.getSession({ headers: new Headers({ Cookie: cookie }), query: { disableRefresh: true } });
    assert.ok(session);
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(session.session.expiresAt.getTime() - Date.now() - yearMs) < 10_000);

    // Emulate an existing seven-day cookie. Never bulk-extend or revive sessions.
    await appPool!.query('UPDATE session SET "expiresAt" = now() + interval \'6 days\', "updatedAt" = now() - interval \'1 day\' WHERE id = $1', [session.session.id]);
    const before = (await appPool!.query('SELECT "expiresAt", "updatedAt" FROM session WHERE id = $1', [session.session.id])).rows[0];
    assert.equal(await hasOwnerSession(new Headers({ Cookie: cookie })), true);
    const afterCheck = (await appPool!.query('SELECT "expiresAt", "updatedAt" FROM session WHERE id = $1', [session.session.id])).rows[0];
    assert.deepEqual(afterCheck, before, "Read-only authorization must not silently consume cookie renewal");

    const renewed = await getAuth().handler(new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } }));
    assert.equal(renewed.status, 200);
    assert.ok(renewed.headers.getSetCookie().some(value => /session_token=.*Max-Age=31536000/i.test(value)));
    const afterRenew = (await appPool!.query('SELECT "expiresAt" FROM session WHERE id = $1', [session.session.id])).rows[0];
    assert.ok(Math.abs(afterRenew.expiresAt.getTime() - Date.now() - yearMs) < 10_000);

    await appPool!.query('UPDATE session SET "expiresAt" = now() - interval \'1 minute\' WHERE id = $1', [session.session.id]);
    const expired = await getAuth().handler(new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } }));
    assert.equal(await expired.json(), null, "Expired sessions must require a fresh login");
    assert.equal(await hasOwnerSession(new Headers({ Cookie: cookie })), false);
  });
});
