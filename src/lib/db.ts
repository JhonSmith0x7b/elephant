import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

const databaseGlobal = globalThis as typeof globalThis & {
  elephantPool?: Pool;
  elephantDb?: Database;
};

export function getPool(): Pool {
  if (!databaseGlobal.elephantPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("请先配置 DATABASE_URL，并运行数据库初始化。");
    }
    databaseGlobal.elephantPool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle connection can be terminated by a serverless database without
    // making the next request unusable. The pool replaces that connection.
    databaseGlobal.elephantPool.on("error", () => {});
  }
  return databaseGlobal.elephantPool;
}

export function getDb(): Database {
  databaseGlobal.elephantDb ??= drizzle(getPool(), { schema });
  return databaseGlobal.elephantDb;
}
