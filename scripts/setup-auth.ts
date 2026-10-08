import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/lib/auth";
import { getPool } from "../src/lib/db";

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  throw new Error("请在环境变量中填写 ADMIN_EMAIL 和至少 12 位的 ADMIN_PASSWORD。");
}
try {
  const auth = createAuth(true);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const existing = await getPool().query('SELECT id FROM "user" WHERE email = $1', [email]);
  if (!existing.rowCount) {
    await auth.api.signUpEmail({ body: { email, password, name: "读者" } });
    console.log("管理员已创建，公开注册保持关闭。");
  } else console.log("管理员已存在，未修改密码。");
} finally { await getPool().end(); }
