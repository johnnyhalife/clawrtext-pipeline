/**
 * backfill-evidence-trail.ts
 *
 * Backfills evidence_trail rows from existing entries.jsonl files for projects
 * that were processed before evidence_trail wiring was added.
 *
 * Safe to re-run — inserts ON CONFLICT DO NOTHING.
 * deck_hash left NULL (PPTX not available for hashing at backfill time).
 * model set to current MODEL_REDUCE value.
 *
 * Usage:
 *   npx tsx src/backfill-evidence-trail.ts                    # all codenames
 *   npx tsx src/backfill-evidence-trail.ts --codename rhyzono # single
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { db, closeDb } from "./db.js";
import { CLAWRTEX_ROOT, MODEL_REDUCE, statePath } from "./config.js";
import type { DeckEntry } from "./reduce.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const filterCodename = arg("codename");

function loadCodenames(): string[] {
  if (filterCodename) return [filterCodename];
  const registry = JSON.parse(
    readFileSync(resolve(CLAWRTEX_ROOT, "registry.json"), "utf-8")
  ) as Array<{ codename: string }>;
  return registry.map(e => e.codename);
}

async function backfillCodename(codename: string): Promise<void> {
  const entriesPath = statePath(codename, "entries.jsonl");
  if (!existsSync(entriesPath)) {
    console.error(`[backfill] ${codename}: no entries.jsonl found — skipping`);
    return;
  }

  const entries: DeckEntry[] = readFileSync(entriesPath, "utf-8")
    .split("\n").filter(Boolean)
    .map(l => JSON.parse(l) as DeckEntry);

  if (entries.length === 0) {
    console.error(`[backfill] ${codename}: entries.jsonl is empty — skipping`);
    return;
  }

  console.error(`[backfill] ${codename}: ${entries.length} entries to backfill`);

  let inserted = 0;
  let skipped = 0;

  for (const entry of entries) {
    const result = await db().query(
      `INSERT INTO evidence_trail
         (codename, source, deck_name, deck_date, model, slide_count, deck_hash, run_at)
       VALUES ($1, 'decks', $2, $3, $4, $5, NULL, $6)
       ON CONFLICT DO NOTHING`,
      [
        codename,
        entry.deck_name,
        entry.deck_date === "unknown" ? null : entry.deck_date,
        MODEL_REDUCE,
        entry.slide_count,
        entry.reduced_at ?? new Date().toISOString(),
      ]
    );
    if (result.rowCount && result.rowCount > 0) {
      inserted++;
    } else {
      skipped++;
    }
  }

  console.error(`[backfill] ${codename}: ${inserted} inserted, ${skipped} already existed`);
}

async function run(): Promise<void> {
  const codenames = loadCodenames();
  console.error(`[backfill] processing ${codenames.length} codename(s): ${codenames.join(", ")}`);

  for (const codename of codenames) {
    await backfillCodename(codename);
  }

  console.error(`[backfill] done.`);
}

run().finally(closeDb);
