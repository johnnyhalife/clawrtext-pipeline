import { Pool } from "pg";
import { PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD } from "./config.js";

// Shared singleton pool — imported by all pipeline phases that need PG.
// Call db.end() only in top-level entrypoints (pipeline.ts, ingest-sources.ts).

let _pool: Pool | null = null;

export function db(): Pool {
  if (!_pool) {
    _pool = new Pool({
      host: PG_HOST, port: PG_PORT,
      database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD,
      max: 5,
    });
  }
  return _pool;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
