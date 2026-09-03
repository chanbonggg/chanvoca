import type { Queryable } from "../../shared/db.js";

type OwnerRow = { id: string };

export async function getOwnerId(sql: Queryable) {
  const existing = await sql<OwnerRow[]>`
    SELECT id
    FROM users
    WHERE display_name = 'owner'
    LIMIT 1
  `;

  if (existing[0]) return existing[0].id;

  const inserted = await sql<OwnerRow[]>`
    INSERT INTO users ${sql({ display_name: "owner" })}
    ON CONFLICT (display_name) DO NOTHING
    RETURNING id
  `;

  if (inserted[0]) return inserted[0].id;

  const owner = await sql<OwnerRow[]>`
    SELECT id
    FROM users
    WHERE display_name = 'owner'
    LIMIT 1
  `;

  if (!owner[0]) throw new Error("Unable to create the owner user.");

  return owner[0].id;
}
