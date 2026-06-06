/**
 * backfill-chunk-deals.ts
 *
 * Populates chunk_deals (N:M) by attributing each chunk to the deal(s)
 * whose start_date is closest to the chunk's deck_date.
 *
 * Rules:
 *   - Match key: chunk.codename === deal.codename
 *   - Distance:  ABS(chunk.deck_date - deal.start_date) in days
 *   - All deals at minimum distance get attributed (ties → multiple rows)
 *   - No max distance, no nulls — every chunk with a deck_date gets ≥1 deal
 *   - Idempotent: DELETE + INSERT per chunk (safe to re-run)
 *
 * Usage:
 *   npx tsx src/backfill-chunk-deals.ts
 *   npx tsx src/backfill-chunk-deals.ts --codename tartan
 *   npx tsx src/backfill-chunk-deals.ts --dry-run
 */

import { db, closeDb } from "./db.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
const filterCodename = arg("codename");
const dryRun = process.argv.includes("--dry-run");

async function run(): Promise<void> {
  const pool = db();

  console.error(`[backfill-chunk-deals] starting${filterCodename ? ` (${filterCodename})` : " (all codenames)"}${dryRun ? " — DRY RUN" : ""}`);

  // Single query: for each chunk, find all deals at minimum distance
  // Uses a window function to rank deals per chunk, then keeps only rank=1 (ties included)
  const whereCodename = filterCodename ? `AND c.codename = $1` : "";
  const params = filterCodename ? [filterCodename] : [];

  const { rows: attributions } = await pool.query<{
    chunk_id: number;
    deal_id: number;
    distance_days: number;
    codename: string;
  }>(
    `
    WITH ranked AS (
      SELECT
        c.id                                                            AS chunk_id,
        d.id                                                            AS deal_id,
        c.codename,
        ABS(c.deck_date - d.start_date::date)                          AS distance_days,
        MIN(ABS(c.deck_date - d.start_date::date))
          OVER (PARTITION BY c.id)                                      AS min_distance
      FROM chunks c
      JOIN pd_deals d
        ON d.codename = c.codename
       AND d.start_date IS NOT NULL
      WHERE c.deck_date IS NOT NULL
        ${whereCodename}
    )
    SELECT chunk_id, deal_id, distance_days, codename
    FROM ranked
    WHERE distance_days = min_distance
    ORDER BY codename, chunk_id, deal_id
    `,
    params
  );

  console.error(`[backfill-chunk-deals] ${attributions.length} chunk→deal attributions computed`);

  // Stats by codename
  const byCodename = new Map<string, number>();
  for (const row of attributions) {
    byCodename.set(row.codename, (byCodename.get(row.codename) ?? 0) + 1);
  }
  for (const [codename, count] of byCodename) {
    console.error(`  ${codename}: ${count} attributions`);
  }

  if (dryRun) {
    console.error(`[backfill-chunk-deals] DRY RUN — no writes`);
    return;
  }

  // Clear existing attributions for affected codenames, then insert
  const affectedCodenames = [...byCodename.keys()];
  if (affectedCodenames.length > 0) {
    await pool.query(
      `DELETE FROM chunk_deals
       WHERE chunk_id IN (
         SELECT id FROM chunks WHERE codename = ANY($1)
       )`,
      [affectedCodenames]
    );
  }

  // Batch insert
  let inserted = 0;
  for (const row of attributions) {
    await pool.query(
      `INSERT INTO chunk_deals (chunk_id, deal_id, distance_days)
       VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id, deal_id) DO UPDATE SET distance_days = EXCLUDED.distance_days`,
      [row.chunk_id, row.deal_id, row.distance_days]
    );
    inserted++;
  }

  console.error(`[backfill-chunk-deals] done — inserted=${inserted}`);
}

run().catch(e => {
  console.error("[backfill-chunk-deals] fatal:", e);
  process.exit(1);
}).finally(closeDb);
