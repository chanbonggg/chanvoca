import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";

export type Database = Sql;
export type Queryable = Sql | TransactionSql;

export function createDatabase(databaseUrl = process.env.DATABASE_URL): Database {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  return postgres(databaseUrl, { max: 10, idle_timeout: 20 });
}
