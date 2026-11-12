import * as NodeFSP from "node:fs/promises";

import type pg from "pg";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const LOCK_ID = 7_312_004_101;

export const migrate = async (pool: pg.Pool) => {
  const files = (await NodeFSP.readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .toSorted();
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const { rows } = await client.query<{ name: string }>("select name from schema_migrations");
    const applied = new Set(rows.map((row) => row.name));
    for (const file of files.filter((name) => !applied.has(name))) {
      const sql = await NodeFSP.readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      console.log(`applied migration ${file}`);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    client.release();
  }
};
