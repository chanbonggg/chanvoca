import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Database } from "./db.js";
import { currentLog } from "./logger.js";

type AppliedMigration = { name: string };

export async function applyMigrations(
  sql: Database,
  directory = resolve(process.cwd(), "db/migrations"),
) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = await sql<AppliedMigration[]>`SELECT name FROM schema_migrations`;
  const appliedNames = new Set(applied.map(({ name }) => name));

  for (const name of files) {
    if (appliedNames.has(name)) continue;

    const started = performance.now();
    currentLog().info({ event: "migration.started", migration: name }, "Applying migration");
    try {
      const source = await readFile(resolve(directory, name), "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
        await transaction`INSERT INTO schema_migrations ${transaction({ name })}`;
      });
      currentLog().info({ event: "migration.completed", migration: name, durationMs: performance.now() - started }, "Migration committed");
    } catch (err) {
      currentLog().error({ event: "migration.failed", migration: name, err }, "Migration failed");
      throw err;
    }
  }
}
