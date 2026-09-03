import { createDatabase } from "./shared/db.js";
import { applyMigrations } from "./shared/migrations.js";

const sql = createDatabase();

try {
  await applyMigrations(sql);
  console.log("Database migrations are up to date.");
} finally {
  await sql.end();
}

