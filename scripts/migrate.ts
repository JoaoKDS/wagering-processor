import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MigrationDirection = "up" | "down" | "reset";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".up.sql"))
    .map((f) => f.replace(/\.up\.sql$/, ""))
    .sort();
}

function readMigration(name: string, kind: "up" | "down"): string {
  return readFileSync(join(MIGRATIONS_DIR, `${name}.${kind}.sql`), "utf8");
}

/**
 * Aplica (up), reverte o último (down) ou reverte tudo e reaplica (reset).
 * Cada migration roda numa transação: DDL do Postgres é transacional, então falha no meio não deixa schema pela metade.
 */
export async function runMigrations(sql: SQL, direction: MigrationDirection): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  if (direction === "reset") {
    await runMigrations(sql, "down");
    // roda down até não restar nada aplicado
    while ((await appliedNames(sql)).length > 0) {
      await runMigrations(sql, "down");
    }
    await runMigrations(sql, "up");
    return;
  }

  if (direction === "up") {
    const applied = new Set(await appliedNames(sql));
    for (const name of migrationNames()) {
      if (applied.has(name)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readMigration(name, "up"));
        await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
      });
      console.log(`up   ${name}`);
    }
    return;
  }

  const applied = await appliedNames(sql);
  const last = applied.at(-1);
  if (!last) return;
  await sql.begin(async (tx) => {
    await tx.unsafe(readMigration(last, "down"));
    await tx`DELETE FROM schema_migrations WHERE name = ${last}`;
  });
  console.log(`down ${last}`);
}

async function appliedNames(sql: SQL): Promise<string[]> {
  const rows = await sql`SELECT name FROM schema_migrations ORDER BY name`;
  return rows.map((r: { name: string }) => r.name);
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Defina DATABASE_URL, ex.: postgres://postgres:postgres@localhost:5432/wagering");
    process.exit(1);
  }
  const direction = (process.argv[2] ?? "up") as MigrationDirection;
  if (!["up", "down", "reset"].includes(direction)) {
    console.error("Uso: bun scripts/migrate.ts [up|down|reset]");
    process.exit(1);
  }
  const sql = new SQL(url);
  try {
    await runMigrations(sql, direction);
  } finally {
    await sql.close();
  }
}
