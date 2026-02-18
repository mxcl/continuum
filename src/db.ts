import fs from "node:fs/promises";
import path from "node:path";

import { Pool, PoolClient, QueryResultRow } from "pg";

import { config } from "./config";

export const pool = new Pool({
  connectionString: config.DATABASE_URL
});

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runSchemaMigration(): Promise<void> {
  const schemaPath = path.resolve(process.cwd(), "db/schema.sql");
  const sql = await fs.readFile(schemaPath, "utf8");
  await pool.query(sql);
}

