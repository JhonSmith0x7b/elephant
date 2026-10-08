import { betterAuth } from "better-auth";
import { getPool } from "./db";

export function isLocalDevelopment() {
  return process.env.NODE_ENV === "development" && !process.env.VERCEL && process.env.LOCAL_DEV_AUTH_BYPASS === "1";
}

export function createAuth(allowSignUp = false) {
  if (!process.env.BETTER_AUTH_SECRET || !process.env.BETTER_AUTH_URL) {
    throw new Error("请配置 BETTER_AUTH_SECRET 和 BETTER_AUTH_URL。");
  }
  return betterAuth({
    appName: "大象",
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    database: getPool(),
    emailAndPassword: { enabled: true, disableSignUp: !allowSignUp },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    session: { expiresIn: 60 * 60 * 24 * 7 },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return auth ??= createAuth();
}

export async function hasOwnerSession(headers: Headers) {
  const session = await getAuth().api.getSession({ headers });
  return Boolean(session && process.env.ADMIN_EMAIL && session.user.email.toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase());
}
