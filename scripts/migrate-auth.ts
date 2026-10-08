import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/lib/auth";
import { getPool } from "../src/lib/db";

try {
  const { runMigrations } = await getMigrations(createAuth().options);
  await runMigrations();
  console.log("登录数据库迁移完成。");
} catch {
  console.error("登录数据库迁移失败，请检查配置与数据库权限。");
  process.exitCode = 1;
} finally {
  await getPool().end();
}
