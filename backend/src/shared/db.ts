import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { createHash } from "node:crypto";
import { currentLog, logContext } from "./logger.js";

export type Database = Sql;
export type Queryable = Sql | TransactionSql;

export function createDatabase(databaseUrl = process.env.DATABASE_URL): Database {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  return postgres(databaseUrl, {
    max: 10, idle_timeout: 20,
    debug(connectionId, query, parameters) {
      currentLog().debug({
        event: "db.query", connectionId, stage: logContext.getStore()?.stage,
        queryId: createHash("sha256").update(query).digest("hex").slice(0, 16),
        operation: query.trim().split(/\s+/)[0]?.toUpperCase(), parameterCount: parameters.length,
      }, "Database query dispatched");
    },
    onnotice(notice) { currentLog().debug({ event: "db.notice", code: notice.code }, "Database notice"); },
    onclose(connectionId) { currentLog().debug({ event: "db.connection_closed", connectionId }, "Database connection closed"); },
  });
}
