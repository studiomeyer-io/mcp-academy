/**
 * Postgres pool fuer mcp-skills.
 *
 * Multi-tenant gegen die EIGENE DB `academy_mcp`. Raw `pg` (kein Prisma) —
 * MCP-Server-Regel: nie prisma db push, Schema lebt in scripts/schema.sql.
 * NIEMALS gegen matthiasmeyer_db richten.
 */

import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

export function getDb(): Pool {
  if (pool) return pool;
  const url = process.env.ACADEMY_MCP_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "ACADEMY_MCP_DATABASE_URL not set. Point it at academy_db — the Academy website's own database. " +
        "This server writes its academy_mcp_* tables there and READS Prisma's \"User\" table; " +
        "a URL pointing anywhere else makes every address look unknown. " +
        "Example: postgres://matthiasmeyer:PASSWORD@localhost:5433/academy_db",
    );
  }
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", (err: unknown) => {
    console.error("[academy-db] unexpected pool error:", err);
  });
  return pool;
}

/** Test-only: replace pool with a stub. */
export function __setPoolForTest(replacement: Pool | null): void {
  pool = replacement;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
